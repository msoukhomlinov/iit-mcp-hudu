/**
 * tools/reads.ts — the curated CORE read tools: resolve, get-context, find-by-slug and get.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { KnowledgeResource } from 'node-hudu';
import { TOOL_DESCRIPTIONS } from 'node-hudu/mcp';
import { assertSecretReadPermitted } from '../policy.js';
import { redactCompanyContextCredentials } from './company-context-policy.js';
import { lossyNote, takeContentLoss } from './article-loss.js';
import type { ToolContext } from './context.js';
import { contextErrorContent, errorContent, createResultBuilders, resolveErrorContent } from './results.js';
import { ASSET_IDENTIFIER, CONTEXT_OUTPUT, DEFAULT_LIMIT, EXPAND, HITS_OUTPUT, IDENTIFIER, LIMIT, ONE_OUTPUT, resourceEnum } from './schemas.js';

/** Register the eleven CORE read tools after `hudu_search`, in `CORE_TOOLS` order. */
export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const { ok, oneResult } = createResultBuilders(ctx.huduOrigin);
  const { hudu, config, log, ops, searchableResources } = ctx;
  server.registerTool(
    'hudu_resolve_any',
    {
      title: 'Resolve Any',
      description: TOOL_DESCRIPTIONS['hudu_resolve_any'],
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name/slug, or an identifier object; resolved against every requested resource.'),
        opts: z
          .object({
            resources: z
              .array(resourceEnum(searchableResources))
              .optional()
              .describe(
                `Resources to try, in fan-out order; default this deployment's searchable set: ${searchableResources.join(', ')}. ` +
                  'A resource outside HUDU_SEARCH_RESOURCES is refused before any request.',
              ),
            limit: LIMIT,
          })
          .optional()
          .describe('Optional resolve options: which resources to try and how many matches to return.'),
      }),
      outputSchema: HITS_OUTPUT,
      // Derived from the curated manifest annotations (readOnlyHint / destructiveHint /
      // idempotentHint / openWorldHint); the SDK's ToolAnnotations type has exactly those keys.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        // An omitted `resources` resolves against the deployment's searchable set, never the SDK's
        // full eight: on a narrowed deployment the omitted-argument path would otherwise fan out over
        // a resource this credential cannot read and return its auth error.
        const resources = opts?.resources ?? searchableResources;
        const limit = opts?.limit ?? DEFAULT_LIMIT;
        const resolved = await ops.resolveAny(identifier, { resources: resources as KnowledgeResource[], limit });
        const refused = resolved.unauthorized ?? [];
        return ok(
          `Found ${resolved.hits.length} candidate(s).` +
            (resolved.truncated.length ? ` These resources hit their scan cap and are undecided: ${resolved.truncated.join(', ')}.` : '') +
            (refused.length ? ` The credential may not read ${refused.join(', ')}: an empty result there is not "no match".` : ''),
          { hits: resolved.hits, total: resolved.hits.length, truncated: resolved.truncated, scanned: resolved.scanned, unauthorized: refused },
        );
      } catch (err) {
        return resolveErrorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_api_info',
    {
      title: 'Get Api Info',
      description: TOOL_DESCRIPTIONS['hudu_get_api_info'],
      inputSchema: z.object({
        identifier: IDENTIFIER.optional().describe('Optional identifier; omit it for the tenant-wide api info.'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: ONE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return oneResult('api info', await hudu.apiInfo.resolve(args.identifier, args.opts));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_company_context',
    {
      title: 'Get Company Context',
      description: TOOL_DESCRIPTIONS['hudu_get_company_context'] +
        ' Context depends on the resources available to this deployment; a refused credential answers UNAUTHORIZED (401, "Bad credentials") like every other tool unless the refused sub-list is left out with opts.skip, and any other failure keeps its real code — never partial results.',
      inputSchema: z.object({
        id: z.number().int().positive().describe('Numeric company id.'),
        opts: z.object({
          limit: LIMIT,
          expand: EXPAND,
          skip: z.array(z.enum(['assets', 'articles', 'websites', 'asset_passwords'])).optional().describe('Sub-lists to leave out (no request is made for them); pass ["asset_passwords"] when the key cannot read credentials.'),
        }).optional().describe('Optional read options: limit bounds the rows, expand returns full typed records, skip omits sub-lists.'),
      }),
      outputSchema: CONTEXT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { id, opts } = args;
      try {
        // The SDK overloads `expand` on the literal `true`, so the flag has to branch rather than
        // ride along in an options bag — the same shape the reference server uses.
        const limit = opts?.limit ?? DEFAULT_LIMIT;
        const skip = opts?.skip;
        const raw = opts?.expand
          ? await hudu.companies.getContext(id, { limit, expand: true, skip })
          : await hudu.companies.getContext(id, { limit, skip });
        const context = redactCompanyContextCredentials(raw, 'companies.getContext', config, log);
        const skipped = (raw as { skipped?: string[] }).skipped;
        return ok(`Context for company ${id}: each sub-list bounded to ${limit}${skipped?.length ? `; skipped ${skipped.join(', ')}` : ''}.`, { context, ...(skipped ? { skipped } : {}) });
      } catch (err) {
        return contextErrorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_article_context',
    {
      title: 'Get Article Context',
      description: TOOL_DESCRIPTIONS['hudu_get_article_context'] +
        ' Article bodies in the context are Markdown.' +
        ' Context depends on the resources available to this deployment; a refused credential answers UNAUTHORIZED (401, "Bad credentials") like every other tool, and any other failure keeps its real code — never partial results.',
      inputSchema: z.object({
        id: z.number().int().positive().describe('Numeric article id (hudu_get_article_context takes the id; use hudu_search or hudu_read / hudu_write / hudu_delete with articles.resolve to find it).'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: CONTEXT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        // The SDK converts and reports loss on the record (see article-loss.ts).
        const stored = args.opts?.expand
          ? await hudu.articles.getContext(args.id, { expand: true, format: 'markdown' })
          : await hudu.articles.getContext(args.id, { format: 'markdown' });
        const { result: context, codes: lossy } = takeContentLoss('articles.getContext', stored);
        return ok('Article context returned.' + (lossy.length ? lossyNote(lossy) : ''), {
          context,
          ...(lossy.length ? { markdown_lossy: true, markdown_lossy_codes: lossy } : {}),
        });
      } catch (err) {
        return contextErrorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_asset_context',
    {
      title: 'Get Asset Context',
      description: TOOL_DESCRIPTIONS['hudu_get_asset_context'] +
        ' Context depends on the resources available to this deployment; a refused credential answers UNAUTHORIZED (401, "Bad credentials") like every other tool, and any other failure keeps its real code — never partial results.',
      inputSchema: z.object({
        identifier: ASSET_IDENTIFIER.describe('Id, name, slug, primary serial or { id, companyId }.'),
        opts: z.object({ limit: LIMIT, expand: EXPAND }).optional().describe('Optional read options: limit bounds the rows, expand returns full typed records.'),
      }),
      outputSchema: CONTEXT_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { identifier, opts } = args;
      try {
        const limit = opts?.limit ?? DEFAULT_LIMIT;
        const raw = opts?.expand
          ? await hudu.assets.getContext(identifier, { limit, expand: true })
          : await hudu.assets.getContext(identifier, { limit });
        const context = raw;
        return ok(`Context for the asset, each sub-list bounded to ${limit}.`, { context });
      } catch (err) {
        return contextErrorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_asset_layout',
    {
      title: 'Get Asset Layout',
      description: TOOL_DESCRIPTIONS['hudu_get_asset_layout'],
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name/slug, or an identifier object.'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: ONE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const record = args.opts?.expand
          ? await hudu.assetLayouts.resolve(args.identifier, { expand: true })
          : await hudu.assetLayouts.resolve(args.identifier);
        return oneResult('asset layout', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_find_asset_passwords_by_slug',
    {
      title: 'Find Asset Passwords By Slug',
      description: TOOL_DESCRIPTIONS['hudu_find_asset_passwords_by_slug'],
      inputSchema: z.object({
        // `findBySlug` takes a slug, not the general identifier union: the SDK signature is
        // `(slug: string)`. The reference's shared IDENTIFIER here is a generated artefact.
        slug: z.string().min(1).describe('Exact slug of the asset password.'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: ONE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        // Gated on the whole operation, not on `expand`: the deny decision is about reaching the
        // resource at all, and a curated tool must not be a way around the policy `hudu_read / hudu_write / hudu_delete`
        // enforces for the same key.
        assertSecretReadPermitted('asset_passwords.findBySlug', config, log);
        const record = args.opts?.expand
          ? await hudu.assetPasswords.findBySlug(args.slug, { expand: true })
          : await hudu.assetPasswords.findBySlug(args.slug);
        return oneResult('asset password', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_find_websites_by_slug',
    {
      title: 'Find Websites By Slug',
      description: TOOL_DESCRIPTIONS['hudu_find_websites_by_slug'],
      inputSchema: z.object({
        slug: z.string().min(1).describe('Exact slug of the website.'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: ONE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const record = args.opts?.expand
          ? await hudu.websites.findBySlug(args.slug, { expand: true })
          : await hudu.websites.findBySlug(args.slug);
        return oneResult('website', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_folder',
    {
      title: 'Get Folder',
      description: TOOL_DESCRIPTIONS['hudu_get_folder'],
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name/slug, or an identifier object.'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: ONE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const record = args.opts?.expand
          ? await hudu.folders.resolve(args.identifier, { expand: true })
          : await hudu.folders.resolve(args.identifier);
        return oneResult('folder', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_password_folder',
    {
      title: 'Get Password Folder',
      description: TOOL_DESCRIPTIONS['hudu_get_password_folder'],
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name/slug, or an identifier object.'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: ONE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        assertSecretReadPermitted('password_folders.resolve', config, log);
        const record = args.opts?.expand
          ? await hudu.passwordFolders.resolve(args.identifier, { expand: true })
          : await hudu.passwordFolders.resolve(args.identifier);
        return oneResult('password folder', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_get_group',
    {
      title: 'Get Group',
      description: TOOL_DESCRIPTIONS['hudu_get_group'],
      inputSchema: z.object({
        identifier: IDENTIFIER.describe('Id, exact name/slug, or an identifier object.'),
        opts: z.object({ expand: EXPAND }).optional().describe('Optional read options: expand returns full typed records.'),
      }),
      outputSchema: ONE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const record = args.opts?.expand
          ? await hudu.groups.resolve(args.identifier, { expand: true })
          : await hudu.groups.resolve(args.identifier);
        return oneResult('group', record);
      } catch (err) {
        return errorContent(err);
      }
    },
  );
}
