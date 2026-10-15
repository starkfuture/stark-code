import createDOMPurify from "dompurify";

/** Offline document with one trusted bridge; never load page scripts or remote assets. */
export function publishedHtmlDocument(html: string): string {
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- Synchronous browser CSP nonce for this isolated document.
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "href" && node.nodeName.toLowerCase() === "a") {
      node.setAttribute("data-stark-link", data.attrValue);
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "link");
      data.keepAttr = false;
    }
  });
  const clean = purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "meta", "link"],
    FORBID_ATTR: ["srcdoc", "href", "target", "ping", "download", "autofocus"],
  });
  // The only script forwards a deliberate link click. The host validates both sender and URL.
  const bridge = `<script nonce="${nonce}">function open(e){const a=e.target.closest?.('a[data-stark-link]');if(!a)return;e.preventDefault();const u=a.getAttribute('data-stark-link');if(u?.startsWith('#')){document.getElementById(u.slice(1))?.scrollIntoView();return;}parent.postMessage({source:'stark-published-page',url:u},${JSON.stringify(window.location.origin)});}document.addEventListener('click',open);document.addEventListener('keydown',e=>{if(e.key==='Enter')open(e);});</script>`;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{font:15px/1.6 system-ui,sans-serif;padding:20px;color:#202124;overflow-wrap:anywhere}img{max-width:100%}pre{white-space:pre-wrap}table{border-collapse:collapse;max-width:100%}td,th{padding:6px;border:1px solid #ccc}</style></head><body>${clean}${bridge}</body></html>`;
}
