// `node --test relay/test/` lands here: Node 22+ treats --test arguments as globs, so a bare directory
// is resolved like a module (to this index.js). It loads every suite. `node --test test/*.test.js` works too.
import "./relay-crypto.test.js";
import "./relay-core.test.js";
import "./worker.test.js";
import "./end-to-end.test.js";
