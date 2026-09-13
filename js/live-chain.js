/* Compatibility loader for the canonical onchain analytics implementation.
 * The maintained implementation lives at /live-chain.js. Keeping this small
 * loader preserves the existing index.html script path without maintaining a
 * second, stale copy of the RPC/read logic.
 */
(function () {
  "use strict";
  const script = document.createElement("script");
  script.src = new URL("live-chain.js", document.baseURI).toString();
  script.defer = true;
  document.head.appendChild(script);
})();
