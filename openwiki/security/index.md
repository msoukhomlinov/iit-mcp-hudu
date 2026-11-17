# Files

- [Authentication, credentials and base hosts](auth-and-base-hosts.md) - How the HTTP transport takes per-request Hudu credentials and origins, how the client is resolved and fails closed, how allowed base hosts guard against outbound abuse, and which credential shape anomalies are refused.
- [Write policy, read-only mode and secret reads](write-policy.md) - How the deployment gates writes (deny, allow_list, all, with HUDU_READ_ONLY as a hard override), how credential reads are refused, which operations are never reachable, and how refusals surface to the model.
