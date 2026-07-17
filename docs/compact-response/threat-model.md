# Compact Response threat model

| Threat                                               | Control                                                                                                             | Residual boundary                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Candidate injects fields the renderer did not expect | Strict JSON, duplicate-key rejection, closed object schemas, no coercion                                            | The model can still choose a wrong but schema-valid value                   |
| Contract activates code or remote references         | Fixed bounded dialect; no refs, regexes, templates, imports, or extensions                                          | The host remains responsible for selecting a reviewed contract              |
| Renderer substitution or version skew                | Exact ID, version, artifact digest, media type, and locale binding                                                  | Digests do not authenticate the artifact producer                           |
| Candidate/output mutation across async work          | Immediate byte copies, strict parse, deep freeze, copied renderer registration and output                           | A malicious host can ignore the returned result                             |
| Parser or renderer resource exhaustion               | Byte/depth/item/string/schema-node limits, deadline, output cap, abort signal                                       | Synchronous hostile renderer code needs worker/process isolation            |
| Partial or raw fallback leaks                        | Only `rendered` contains output; every failure returns bounded reasons with no candidate/output                     | A caller could separately log its own source bytes                          |
| Markdown injection                                   | Demonstration renderer escapes model-provided text and code spans                                                   | Other renderer profiles need their own security review                      |
| False savings claim                                  | Raw candidate bytes and rendered bytes are counted locally; reliability is labelled; billed savings are always null | Only provider usage can establish real billing impact                       |
| Witness replay or tampering                          | Exact contract/candidate/renderer/output/tokenizer binding and canonical witness digest                             | The unsigned witness has no freshness, identity, or authorization semantics |
| Semantic error hidden by valid JSON                  | Schema proves structure only; evaluation and task-specific validation remain host duties                            | No universal semantic proof is claimed                                      |

Privacy tests use sentinels to ensure candidate and rendered content are absent
from witnesses, receipts, errors, and rejection reasons. CLI file output is
private and no-clobber; stdout contains content-free receipts only.
