# Capability Matrix: hudu

## Exposed Capabilities

| Canonical ID | MCP Tool | Type | Composite | Status |
|---|---|---|---|---|
| hudu.registry.list | hudu_list_operations | read | no | available |
| hudu.registry.describe | hudu_describe_operation | read | no | available |
| hudu.registry.read | hudu_read | read | no | available |
| hudu.registry.write | hudu_write | write | no | available |
| hudu.registry.delete | hudu_delete | write (destructive) | no | available |
| hudu.knowledge.search | hudu_search | read | no | available |
| hudu.knowledge.resolve | hudu_resolve_any | read | no | available |
| hudu.api.info | hudu_get_api_info | read | no | available |
| hudu.company.context | hudu_get_company_context | read | yes | available |
| hudu.article.context | hudu_get_article_context | read | yes | available |
| hudu.asset.context | hudu_get_asset_context | read | yes | available |
| hudu.asset-layout.get | hudu_get_asset_layout | read | no | available |
| hudu.password.find-by-slug | hudu_find_asset_passwords_by_slug | read | no | available |
| hudu.website.find-by-slug | hudu_find_websites_by_slug | read | no | available |
| hudu.folder.get | hudu_get_folder | read | no | available |
| hudu.password-folder.get | hudu_get_password_folder | read | no | available |
| hudu.group.get | hudu_get_group | read | no | available |
| hudu.records.list | hudu_list | read | no | available |
| hudu.batch.fetch-many | hudu_fetch_many | read | yes | available |

`hudu_write` and `hudu_delete` exist only when `HUDU_WRITE_POLICY` is `allow_list` or `all`.

## Generic Capability Layer

| Capability | Description |
|---|---|
| hudu_list_operations | List the SDK registry operations, with reachability under this deployment's policy |
| hudu_describe_operation | Full input contract, effect, dry-run support and errors for one operation |
| hudu_read | Execute a registry read by canonical key |
| hudu_write | Execute a registry write; dry-run unless `dry_run:false` |
| hudu_delete | Execute a destructive operation; dry-run unless `dry_run:false`, and `confirm` must equal the key |

The registry is node-hudu 0.20.0: 236 operations. Reachability under a given policy is reported by `hudu_list_operations`.

## Intentionally Omitted

None. Reads that return plaintext secrets (`asset_passwords.*`, `password_folders.*`, including `hudu_find_asset_passwords_by_slug` and `hudu_get_password_folder`) are exposed but refused by default (`HUDU_SECRET_READS=deny`); they are policy-gated, not omitted.

## Blocked Capabilities

`asset_passwords.createShare` (node-hudu 0.17.0): the SDK needs its `reveal` capability to return the new bearer link unmasked and refuses the call without it; this server never grants `reveal`, so the row is listed unreachable. Gaps in the SDK are reported as SDK issues, not worked around here.
