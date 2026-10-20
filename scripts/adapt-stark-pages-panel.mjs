/** App-owned, optional host presentation extension for the pinned Workbench kit.
 * The panel verifies the host origin/source before accepting it. Older hosts keep
 * the original side-panel view; document tabs keep the renderer's normal layout.
 */
export const STARK_PAGES_PRESENTATION_VERSION = 2;

export function adaptStarkPagesPanel(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw new Error("Stark Pages panel changed; review the document presentation adaptation.");
    source = source.replace(before, after);
  };
  replace(
    "agent: d.agent === 'codex' ? 'codex' : 'claude' };",
    "agent: d.agent === 'codex' ? 'codex' : 'claude', presentation: d.presentation === 'document' ? 'document' : 'panel' };",
  );
  replace(
    "agent: 'claude' | 'codex' } | null}",
    "agent: 'claude' | 'codex', presentation: 'panel' | 'document' } | null}",
  );
  replace(
    ".bar{display:flex;",
    `#folder-context{display:none}
body[data-presentation="document"]{--bg:#101112;--fg:#dddcd7;--muted:#9ba196;--line:#363a37;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body[data-presentation="document"] .mark,body[data-presentation="document"] .title,body[data-presentation="document"] #pause,body[data-presentation="document"] #resume{display:none}
body[data-presentation="document"] .bar{min-height:55px;padding:10px 22px;gap:8px 12px}
body[data-presentation="document"] .line1{flex:1;min-width:0;gap:12px}
body[data-presentation="document"] #folder-context{display:block;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
body[data-presentation="document"] .chip{font:500 10px/1.4 var(--sans);text-transform:none;letter-spacing:0;border:1px solid #44483e;border-radius:5px;background:transparent;padding:3px 7px;color:#b8beab}
body[data-presentation="document"] .actions button,body[data-presentation="document"] .actions .btn{border-color:transparent;border-radius:7px;padding:8px 10px;color:#b7bcb0}
body[data-presentation="document"] #publish{background:#c4b483;color:#20241a}
@media(prefers-color-scheme:light){body[data-presentation="document"]{--bg:#f7f7f3;--fg:#272a23;--muted:#636b5d;--line:#d6d9ce}body[data-presentation="document"] .actions button,body[data-presentation="document"] .actions .btn,body[data-presentation="document"] .chip{color:#636b5d}}
.bar{display:flex;`,
  );
  replace(
    '<span class="chip" id="status" hidden></span>',
    '<span class="chip" id="status" hidden></span><span id="folder-context"></span>',
  );
  replace("  var frame = $('view');", "  var frame = $('view');\n  var presentation = 'panel';");
  replace("'/?view=panel&rev='", "'/?' + (presentation === 'panel' ? 'view=panel&' : '') + 'rev='");
  replace(
    "      agent = m.agent;",
    "      agent = m.agent;\n      if (presentation !== m.presentation) {\n        presentation = m.presentation;\n        document.body.setAttribute('data-presentation', presentation);\n        $('pick').textContent = presentation === 'document' ? 'Page library' : 'Pages';\n        $('open').textContent = presentation === 'document' ? 'Open in browser' : 'Open';\n        $('folder-context').textContent = 'Folder pages · ' + String(cfg.root || '').split(String.fromCharCode(92)).join('/').split('/').filter(Boolean).pop();\n        if (presentation === 'document') { setPaused(true); closeMenu(false); }\n        if (current) show(current);\n      }",
  );
  replace(
    "    if (paused) {\n      waiting = p;",
    "    if (presentation === 'document' && current && p.slug !== current.slug) return;\n    if (paused) {\n      waiting = p;",
  );
  replace(
    "$('next').textContent = 'New: ' +",
    "$('next').textContent = presentation === 'document' ? 'Update available' : 'New: ' +",
  );
  return source;
}
