/**
 * The house chain style shared by every dashboard page: fonts, colors, cards,
 * chips, connectors and the light/dark variables. Inlined into each page.
 */
export const CSS = `:root{
  --mono:ui-monospace,'Cascadia Code','JetBrains Mono','SF Mono',Consolas,monospace;
  --sans:ui-sans-serif,'Segoe UI',system-ui,-apple-system,'Helvetica Neue',sans-serif;
  --r:8px;
}
html[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0a0c10; --surface:#12151c; --surface-2:#171b24;
  --border:#232834; --border-strong:#313846;
  --ink:#e6e9ef; --ink-2:#9aa4b2; --ink-3:#626c7d;
  --done:#3fb865; --prog:#4d9dff; --blocked:#ff6b5e; --queued:#8b95a5;
  --accent:#f0a831;
  --done-bg:rgba(63,184,101,.10); --prog-bg:rgba(77,157,255,.10);
  --blocked-bg:rgba(255,107,94,.10); --queued-bg:rgba(139,149,165,.10);
  --accent-bg:rgba(240,168,49,.12);
  --pri-critical:#ff4d4d; --pri-high:#ff8c3a; --pri-medium:#e6c84f;
}
html[data-theme="light"]{
  color-scheme:light;
  --bg:#f6f7f9; --surface:#ffffff; --surface-2:#f1f3f6;
  --border:#dde1e8; --border-strong:#c3c9d3;
  --ink:#11151c; --ink-2:#4a5361; --ink-3:#7a8494;
  --done:#1f8f45; --prog:#1f6fd1; --blocked:#c9372c; --queued:#6b7585;
  --accent:#b8740a;
  --done-bg:rgba(31,143,69,.09); --prog-bg:rgba(31,111,209,.09);
  --blocked-bg:rgba(201,55,44,.09); --queued-bg:rgba(107,117,133,.09);
  --accent-bg:rgba(184,116,10,.10);
  --pri-critical:#d42a2a; --pri-high:#c95a0f; --pri-medium:#8f7a12;
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  background:var(--bg); color:var(--ink); font-family:var(--mono);
  font-size:13px; line-height:1.55; padding:34px 30px 60px; max-width:1280px; margin:0 auto;
  -webkit-font-smoothing:antialiased;
}
body::before{
  content:''; position:fixed; inset:0; z-index:-1; pointer-events:none; opacity:.5;
  background:
    radial-gradient(1100px 500px at 78% -10%, var(--accent-bg), transparent 60%),
    linear-gradient(var(--border) 1px, transparent 1px) 0 0/100% 46px,
    linear-gradient(90deg, var(--border) 1px, transparent 1px) 0 0/46px 100%;
  mask-image:linear-gradient(180deg,#000, transparent 70%);
  -webkit-mask-image:linear-gradient(180deg,#000, transparent 70%);
}
.head{display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:26px}
h1{font-family:var(--sans); font-size:24px; font-weight:750; letter-spacing:-.02em; line-height:1.2; margin:0 0 8px}
.subtitle{font-size:13px; color:var(--ink-2); margin-bottom:8px}
.stamp{font-size:11.5px; color:var(--ink-3)}
.stamp a{color:var(--accent); text-decoration:none; border-bottom:1px dotted color-mix(in srgb, var(--accent) 45%, transparent)}
#theme{background:var(--surface); color:var(--ink-2); border:1px solid var(--border-strong); border-radius:6px; padding:6px 11px; font:inherit; font-size:11.5px; cursor:pointer; white-space:nowrap}
.next{background:var(--surface); border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:var(--r); padding:12px 16px; margin-bottom:26px}
.next-title{font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--accent); font-weight:700; margin-bottom:6px}
.next ol{margin-left:20px; font-family:var(--sans); font-size:13px; line-height:1.5}
.next li{margin:4px 0}
.next b{color:var(--ink); font-family:var(--mono)}
.next .small{font-size:11.5px; color:var(--ink-3); margin-top:8px}
.next .stale{color:var(--blocked)}
.section{margin-bottom:22px}
.section-title{font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-3); font-weight:600; margin-bottom:13px; display:flex; align-items:center; gap:10px}
.section-title::after{content:''; flex:1; height:1px; background:var(--border)}
.section-title.now{color:var(--accent)}
.row{display:flex; gap:14px; align-items:stretch; flex-wrap:wrap}
.row .card{min-width:220px}
.card{
  background:var(--surface); border:1px solid var(--border); border-radius:var(--r);
  padding:14px 16px 12px; position:relative; overflow:hidden; flex:1;
  display:block; text-decoration:none; color:inherit; transition:border-color .12s;
}
.card::before{content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--c)}
.card.done{--c:var(--done)} .card.prog{--c:var(--prog)} .card.blocked{--c:var(--blocked)}
.card.accent{--c:var(--accent)} .card.todo{--c:var(--border-strong)}
a.card:hover{border-color:var(--border-strong)}
.cid{font-family:var(--mono); font-weight:700; color:var(--accent); font-size:13px}
.ctitle{font-family:var(--sans); font-size:14px; font-weight:600; color:var(--ink); margin-top:6px; line-height:1.5;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden}
.cmeta{font-size:11px; color:var(--ink-2); margin-top:6px; line-height:1.5}
.cmeta a{color:var(--accent); text-decoration:none; border-bottom:1px dotted color-mix(in srgb, var(--accent) 45%, transparent)}
.pri-critical{color:var(--pri-critical); font-weight:700} .pri-high{color:var(--pri-high)} .pri-medium{color:var(--pri-medium)} .pri-low{color:var(--ink-3)}
.chip{display:inline-flex; align-items:center; gap:5px; padding:2px 9px; border-radius:5px; font-size:11px; font-weight:600; letter-spacing:.03em; white-space:nowrap; margin-top:10px}
.chip::before{content:''; width:6px; height:6px; border-radius:50%; background:currentColor}
.chip.done{color:var(--done); background:var(--done-bg); border:1px solid color-mix(in srgb, var(--done) 34%, transparent)}
.chip.prog{color:var(--prog); background:var(--prog-bg); border:1px solid color-mix(in srgb, var(--prog) 34%, transparent)}
.chip.blocked{color:var(--blocked); background:var(--blocked-bg); border:1px solid color-mix(in srgb, var(--blocked) 34%, transparent)}
.chip.todo{color:var(--ink-2); background:var(--surface-2); border:1px solid var(--border-strong)}
.chip.parked{color:var(--ink-3); background:var(--surface); border:1px solid var(--border)}
.arrow-down{position:relative; width:2px; height:24px; background:var(--border-strong); margin:8px auto 14px}
.arrow-down::after{content:''; position:absolute; left:50%; bottom:-6px; transform:translateX(-50%); border:5px solid transparent; border-top-color:var(--border-strong)}
.arrow-down.dim{background:var(--border)}
.arrow-down.dim::after{border-top-color:var(--border)}
.gate{margin-top:12px; border:1.5px dashed var(--border-strong); background:var(--surface-2); border-radius:var(--r); padding:8px 14px; font-size:11.5px; color:var(--ink-2); text-align:center}
.gate b{color:var(--ink); letter-spacing:.08em; text-transform:uppercase; font-size:10.5px}
.parked-strip{background:var(--surface); border:1px solid var(--border); border-radius:var(--r); padding:10px 14px; color:var(--ink-3); font-size:11.5px; line-height:1.7; opacity:.75}
.section.parked .section-title{opacity:.75}
.strip a{color:var(--ink-2); text-decoration:none; margin-right:8px; white-space:nowrap}
.strip a:hover{color:var(--accent)}
.empty{font-size:11.5px; color:var(--ink-3)}
.legend{display:flex; gap:16px; font-size:11.5px; color:var(--ink-2)}
.legend span{display:inline-flex; align-items:center; gap:6px}
.toc{display:grid; grid-template-columns:1fr 1fr; grid-auto-flow:column; gap:2px 24px; background:var(--surface); border:1px solid var(--border);
  border-radius:var(--r); padding:10px 14px}
.toc-row{display:flex; align-items:center; gap:8px; padding:3px 0; text-decoration:none; color:var(--ink-2); font-size:12px; min-width:0}
.toc-row b{color:var(--accent); font-weight:700; flex:none}
.toc-row span:last-child{white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:var(--sans)}
.toc-row:hover span:last-child{color:var(--ink)}
.dot{width:7px; height:7px; border-radius:50%; flex:none; background:var(--border-strong)}
.dot.done{background:var(--done)} .dot.prog{background:var(--prog)} .dot.blocked{background:var(--blocked)}
.focus{max-width:760px; margin:0 auto}
.focus .ctitle{font-size:17px; -webkit-line-clamp:unset; display:block}
.group-label{font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); text-align:center; margin:4px 0 8px}
.side{display:flex; gap:14px; flex-wrap:wrap; justify-content:center}
.side .card{flex:0 1 230px}
.tag{display:inline-block; font-size:11px; color:var(--ink-3); border:1px solid var(--border); border-radius:4px; padding:1px 6px; margin:2px 4px 0 0}
.path .ctitle{font-size:13px; font-weight:500}
#jump{background:var(--surface); color:var(--ink); border:1px solid var(--border-strong); border-radius:6px; padding:6px 10px; font:inherit; width:160px}
@media (max-width:760px){ .row{flex-direction:column} .head{flex-direction:column}
  .toc{grid-template-columns:1fr; grid-auto-flow:row; grid-template-rows:none!important} }`;
