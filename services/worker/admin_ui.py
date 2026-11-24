"""运营控制台前端（单文件内嵌，视觉规范来自设计稿「Lexora 运营控制台」画板）。"""

LOGIN_HTML = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Lexora 运营控制台</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;
background:#0E1319;color:#E7EDF4;font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:32px 16px}
.card{width:100%;max-width:400px;background:#141B25;border:1px solid #1E2836;border-radius:16px;padding:36px 34px;display:flex;flex-direction:column;gap:22px}
.mark{width:52px;height:52px;border-radius:14px;background:#123024;display:flex;align-items:center;justify-content:center;margin:0 auto}
h1{margin:10px 0 0;font-size:19px;text-align:center}
.sub{font-size:12.5px;color:#6E8197;text-align:center;margin-top:5px}
label{font-size:12.5px;color:#8CA0B5}
input[type=password]{width:100%;background:#0E1319;border:1px solid #273243;border-radius:10px;padding:12px 14px;font-size:14px;color:#E7EDF4;letter-spacing:2px}
input[type=password]:focus{outline:none;border-color:#2E9E68}
.hint{font-size:11.5px;color:#56677C;margin-top:6px}
button{width:100%;font-size:14.5px;padding:12px 0;border-radius:10px;border:none;background:#2E9E68;color:#07130C;font-weight:700;cursor:pointer}
button:hover{background:#35B377}
.rem{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#8CA0B5;cursor:pointer}
.rem input{width:15px;height:15px;accent-color:#2E9E68}
.err{display:none;font-size:12.5px;color:#FF8585;background:#2B1515;border:1px solid #4A2222;border-radius:8px;padding:9px 12px}
.status{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#5EE6A8;background:#12271C;border:1px solid #1E4631;border-radius:999px;padding:5px 14px}
.dot{width:6px;height:6px;border-radius:50%;background:#3FD68F}
footer{display:flex;flex-wrap:wrap;gap:26px;justify-content:center;align-items:center}
footer a{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:#9FB2C6;text-decoration:none}
footer a:hover{color:#E7EDF4}
.c{font-size:12px;color:#56677C}
</style></head><body>
<form class="card" id="f">
  <div><div class="mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3FD68F" stroke-width="2.2" stroke-linecap="round"><path d="M4 19V5M4 19h16M9 15l3-6 3 4 3-7"/></svg></div>
  <h1>Lexora 运营控制台</h1><div class="sub" id="host"></div></div>
  <div class="err" id="err"></div>
  <div><label for="t">管理 token</label>
    <input id="t" type="password" autocomplete="current-password" placeholder="••••••••••••••••">
    <div class="hint">即 LEXORA_TOKEN · 仅站长持有 · 连续失败 5 次将锁定 10 分钟</div></div>
  <button type="submit">登 录</button>
  <label class="rem"><input type="checkbox" id="rem" checked>7 天内免登录（仅本浏览器）</label>
</form>
<div class="status"><span class="dot"></span><span id="st">服务正常</span></div>
<footer>
  <a href="https://github.com/ClareYu-ZZZ/Obsidian-Lexora"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>GitHub</a>
  <a href="https://clareyu-zzz.github.io/Obsidian-Lexora/"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 18V5.5M8 7h8M8 10.5h5"/></svg>使用文档</a>
  <a href="https://github.com/ClareYu-ZZZ/Obsidian-Lexora/releases"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M4 19h16"/></svg>版本下载</a>
  <span class="c">© 2026 Lexora · MIT</span>
</footer>
<script>
document.getElementById('host').textContent=location.host;
fetch('/healthz').then(r=>r.json()).then(d=>{document.getElementById('st').textContent='服务正常 · v'+d.apiVersion+' · whisper '+d.model}).catch(()=>{});
document.getElementById('f').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const err=document.getElementById('err');err.style.display='none';
  const r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({token:document.getElementById('t').value,remember:document.getElementById('rem').checked})});
  if(r.ok){location.href='/admin';return}
  const d=await r.json().catch(()=>({}));
  err.textContent=d.detail||('登录失败 HTTP '+r.status);err.style.display='block';
});
</script></body></html>"""

ADMIN_HTML = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lexora 运营控制台</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-wrap:wrap;background:#0E1319;color:#E7EDF4;
font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
a{color:#9FB2C6;text-decoration:none}a:hover{color:#E7EDF4}
nav{flex:1 1 216px;max-width:240px;padding:28px 16px;border-right:1px solid #1A2330;display:flex;flex-direction:column;gap:28px}
.logo{display:flex;align-items:center;gap:10px;padding:0 10px}
.mark{width:30px;height:30px;border-radius:9px;background:#123024;display:flex;align-items:center;justify-content:center}
.lt{font-size:15px;font-weight:700}.ls{font-size:11px;color:#6E8197}
.nav{display:flex;flex-direction:column;gap:4px}
.nav button{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:9px;font-size:13.5px;background:none;border:none;color:#9FB2C6;cursor:pointer;text-align:left;width:100%}
.nav button:hover{color:#E7EDF4}
.nav button.on{background:#15331F;color:#5EE6A8;font-weight:600}
.me{margin-top:auto;padding:12px;border-radius:10px;background:#141B25;border:1px solid #1E2836;font-size:12.5px;color:#C3D0DE}
.me small{display:block;font-size:11px;color:#6E8197}
.me a{font-size:11.5px;color:#FF8585}
main{flex:999 1 560px;min-width:0;padding:26px 30px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:19px}
h2{margin:0;font-size:13.5px;font-weight:600;color:#C3D0DE}
.hdr{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#5EE6A8;background:#12271C;border:1px solid #1E4631;border-radius:999px;padding:4px 11px}
.dot{width:6px;height:6px;border-radius:50%;background:#3FD68F}
.muted{font-size:12px;color:#6E8197}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:#141B25;border:1px solid #1E2836;border-radius:12px;padding:15px 16px}
.card .k{font-size:12px;color:#8CA0B5}
.card .v{font-size:26px;font-weight:600;margin-top:5px;font-variant-numeric:tabular-nums}
.card .s{font-size:11px;color:#8CA0B5;margin-top:3px}
.panel{background:#141B25;border:1px solid #1E2836;border-radius:12px;overflow:hidden}
.panel .ph{display:flex;align-items:center;gap:12px;padding:14px 16px 4px}
table{border-collapse:collapse;width:100%}
th{font-size:12px;font-weight:500;color:#8CA0B5;text-align:left;padding:10px 14px;border-bottom:1px solid #212B38}
td{font-size:13px;padding:11px 14px;border-bottom:1px solid #1A2330;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.ok{color:#3FD68F}.bad{color:#FF8585}.warn{color:#E8B44C}
.tag{font-size:11px;border-radius:999px;padding:3px 10px;white-space:nowrap}
.tag.g{color:#5EE6A8;background:#12271C}.tag.y{color:#E8B44C;background:#2B2312}.tag.b{color:#51B7F0;background:#0F2231}.tag.p{color:#C9A6F0;background:#20152E}
.btn{font-size:12.5px;padding:7px 14px;border-radius:8px;border:1px solid #273243;background:#141B25;color:#C3D0DE;cursor:pointer}
.btn:hover{border-color:#3A4A5F}
.btn.pri{border:none;background:#2E9E68;color:#07130C;font-weight:600}.btn.pri:hover{background:#35B377}
.btn.danger{border:none;background:none;color:#FF8585}
.tg{width:36px;height:20px;border-radius:999px;border:1px solid #273243;background:#0E1319;position:relative;cursor:pointer;flex:none}
.tg i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#56677C;transition:all .15s}
.tg.on{background:#2E9E68;border-color:#2E9E68}
.tg.on i{left:18px;background:#EAF6EE;width:16px;height:16px;top:1px}
input[type=text],select{background:#0E1319;border:1px solid #273243;border-radius:8px;padding:9px 12px;font-size:13px;color:#E7EDF4}
input[type=text]:focus{outline:none;border-color:#2E9E68}
svg.chart{display:block;width:100%;height:150px}
.sect{display:none;flex-direction:column;gap:16px}.sect.on{display:flex}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px}
.lib{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}
.lcard{background:#141B25;border:1px solid #1E2836;border-radius:13px;padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.lrow{display:flex;align-items:center;gap:12px}
.lfoot{display:flex;flex-wrap:wrap;gap:16px;align-items:center;border-top:1px solid #1A2330;padding-top:12px}
.sw{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:#C3D0DE}
.drop{border:1.5px dashed #2C3B4E;border-radius:14px;background:#11161E;padding:22px;display:flex;flex-wrap:wrap;align-items:center;gap:18px}
.note{font-size:12px;color:#56677C;line-height:1.7}
.addrow{background:#141B25;border:1px solid #1E2836;border-radius:12px;padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:end}
.fld{display:flex;flex-direction:column;gap:5px}.fld label{font-size:11.5px;color:#8CA0B5}
progress{width:180px;height:8px;accent-color:#2E9E68}
</style></head><body>
<nav>
  <div class="logo"><div class="mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3FD68F" stroke-width="2.2" stroke-linecap="round"><path d="M4 19V5M4 19h16M9 15l3-6 3 4 3-7"/></svg></div>
    <div><div class="lt">Lexora</div><div class="ls">运营控制台</div></div></div>
  <div class="nav" id="nav">
    <button data-s="overview" class="on">概览</button>
    <button data-s="jobs">任务监控</button>
    <button data-s="members">会员订阅</button>
    <button data-s="feeds">推荐源</button>
    <button data-s="library">公版内容库</button>
  </div>
  <div class="me"><small>站长身份</small><span id="who">ops</span><small style="margin-top:4px"><a href="#" id="logout">退出登录</a></small></div>
</nav>
<main>
  <header class="hdr">
    <h1 id="title">概览</h1>
    <span class="pill"><span class="dot"></span><span id="hostline">在线</span></span>
    <span class="muted" id="metaline"></span>
    <button class="btn pri" style="margin-left:auto" onclick="loadAll()">刷新</button>
  </header>

  <section class="sect on" id="s-overview">
    <div class="cards" id="ov-cards"></div>
    <div class="panel"><div class="ph"><h2>系统负载 · 24 小时</h2>
      <span class="muted" style="display:inline-flex;align-items:center;gap:5px"><span style="width:10px;height:2.5px;background:#3FD68F;border-radius:2px"></span>CPU</span>
      <span class="muted" style="display:inline-flex;align-items:center;gap:5px"><span style="width:10px;height:2.5px;background:#5DA9FF;border-radius:2px"></span>内存</span>
      <span class="muted" style="margin-left:auto">30s 采样 · metrics.db</span></div>
      <div style="padding:6px 16px 14px"><svg class="chart" id="chart" viewBox="0 0 960 150" preserveAspectRatio="none" role="img" aria-label="CPU 与内存曲线"></svg></div></div>
    <div class="grid2">
      <div class="panel"><div class="ph"><h2>任务统计 · 7 天</h2></div><table><thead><tr><th>类型</th><th>今日</th><th>7天</th><th>失败</th><th>均耗时</th><th>P95</th></tr></thead><tbody id="ov-kinds"></tbody></table></div>
      <div class="panel"><div class="ph"><h2>近期任务</h2></div><table><thead><tr><th>时间</th><th>类型</th><th>调用方</th><th>耗时</th><th>结果</th></tr></thead><tbody id="ov-recent"></tbody></table></div>
    </div>
  </section>

  <section class="sect" id="s-jobs">
    <div class="panel"><div class="ph"><h2>任务统计 · 7 天</h2></div><table><thead><tr><th>类型</th><th>今日</th><th>7天</th><th>失败</th><th>均耗时</th><th>P50</th><th>P95</th></tr></thead><tbody id="jb-kinds"></tbody></table></div>
    <div class="panel"><div class="ph"><h2>近期任务 · 20 条</h2></div><table><thead><tr><th>时间</th><th>类型</th><th>调用方</th><th>耗时</th><th>结果</th><th>详情</th></tr></thead><tbody id="jb-recent"></tbody></table></div>
  </section>

  <section class="sect" id="s-members">
    <div class="panel"><div class="ph"><h2>付费用户活跃 · 7 天（worker 侧）</h2></div><table><thead><tr><th>邮箱</th><th>今日调用</th><th>7 天调用</th><th>最近活跃</th></tr></thead><tbody id="mb-users"></tbody></table></div>
    <div class="panel"><div class="ph"><h2>已签发订阅</h2><span class="muted">来自 issued.jsonl（licgen 账本，挂载 /data/issued.jsonl）</span></div><table><thead><tr><th>邮箱</th><th>签发</th><th>到期</th><th>价格</th><th>状态</th></tr></thead><tbody id="mb-issued"></tbody></table></div>
  </section>

  <section class="sect" id="s-feeds">
    <div class="hdr"><span class="muted">插件启动时拉取 /v1/recommended-feeds · 保存后全体用户即时生效，无需发版</span>
      <span style="margin-left:auto;display:flex;gap:8px"><a class="btn" href="/v1/recommended-feeds" target="_blank">预览 JSON</a><button class="btn pri" onclick="saveFeeds()">保存并发布</button></span></div>
    <div class="addrow">
      <div class="fld" style="flex:2 1 240px"><label>地址（RSS / B 站 UP 主主页）</label><input type="text" id="nf-url" placeholder="https://space.bilibili.com/…"></div>
      <div class="fld" style="flex:1 1 130px"><label>显示名称</label><input type="text" id="nf-name" placeholder="英语兔"></div>
      <div class="fld" style="flex:1 1 110px"><label>类型</label><select id="nf-type"><option value="bilibili">B站 UP 主</option><option value="rss">播客/RSS</option><option value="article">文章</option><option value="youtube">YouTube 频道</option></select></div>
      <div class="fld" style="flex:1 1 120px"><label>可达性</label><select id="nf-region"><option value="cn">国内直连</option><option value="global">境外（仅直连用户可见）</option></select></div>
      <div class="fld" style="flex:1 1 110px"><label>分组标签</label><input type="text" id="nf-group" placeholder="B站 · 口语"></div>
      <button class="btn pri" onclick="addFeed()">+ 添加</button>
    </div>
    <div class="panel"><table><thead><tr><th style="width:30%">名称</th><th>类型</th><th>地址</th><th>排序</th><th>启用</th><th></th></tr></thead><tbody id="fd-rows"></tbody></table></div>
    <div class="note">说明：标为「境外」的源（YouTube 等）只对能直连 YouTube 的用户展示，插件在用户本机探测，抓取也发生在用户本机网络，服务器不代理任何境外请求；改动先「保存并发布」才会生效。</div>
  </section>

  <section class="sect" id="s-library">
    <div class="hdr"><span class="muted">LibriVox / Gutenberg 等公有领域内容 · 用户在订阅中心「精选课」浏览</span>
      <span style="margin-left:auto" class="muted" id="lib-usage"></span></div>
    <div class="drop">
      <div class="mark" style="width:46px;height:46px;border-radius:12px"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3FD68F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M4 16.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5"/></svg></div>
      <div style="flex:1 1 300px;min-width:0">
        <div style="font-size:14.5px;font-weight:600">新建合集并上传音频 / 字幕文本</div>
        <div class="muted" style="margin-top:4px">mp3 · m4a · mp4 · vtt/srt ｜ 单文件 ≤ 2GB ｜ 仅限公有领域（Public Domain / CC0），须填写来源</div></div>
      <span style="display:flex;gap:10px;flex-wrap:wrap">
        <input type="text" id="nc-title" placeholder="合集名称，如：伊索寓言精选">
        <input type="text" id="nc-source" placeholder="来源，如：LibriVox + Gutenberg" style="width:190px">
        <select id="nc-level"><option>A2</option><option>B1</option><option>B2</option><option>C1</option></select>
        <button class="btn pri" onclick="createCollection()">新建合集</button></span>
    </div>
    <div class="lib" id="lib-cards"></div>
    <div class="note">「试听」对全部用户开放；「免费可生成教程」逐合集控制——建议保留 1-2 门样例课开放免费生成作转化入口，其余 Pro 解锁。</div>
  </section>
</main>
<script>
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=(ts)=>new Date(ts*1000).toLocaleString('zh-CN',{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const dur=(ms)=>ms>=60000?(ms/60000).toFixed(1)+' 分':ms>=1000?(ms/1000).toFixed(1)+' 秒':ms+' ms';
const mb=(b)=>b>=1024**3?(b/1024**3).toFixed(1)+' GB':(b/1048576).toFixed(0)+' MB';
const TITLES={overview:'概览',jobs:'任务监控',members:'会员订阅',feeds:'推荐源配置',library:'公版内容库'};
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('on',x===b));
  document.querySelectorAll('.sect').forEach(s=>s.classList.toggle('on',s.id==='s-'+b.dataset.s));
  $('title').textContent=TITLES[b.dataset.s];
});
$('logout').onclick=async(e)=>{e.preventDefault();await fetch('/admin/logout',{method:'POST'});location.href='/admin';};

async function j(url,opt){const r=await fetch(url,opt);if(r.status===401){location.href='/admin';throw new Error('401')}if(!r.ok)throw new Error((await r.json().catch(()=>({}))).detail||'HTTP '+r.status);return r.json()}

/* ---------- 概览 / 任务 / 会员 ---------- */
async function loadStats(){
  const d=await j('/admin/api/stats');
  const up=Math.floor(d.uptime_s/3600)+'h'+Math.floor(d.uptime_s%3600/60)+'m';
  $('hostline').textContent=location.host+' · 在线';
  $('metaline').textContent=`v${d.apiVersion} · whisper ${d.whisper.model}×${d.whisper.threads}线程 · 运行 ${up}`;
  const s=d.system.now||{};
  const todayJobs=Object.values(d.jobs.kinds).reduce((n,k)=>n+k.today,0);
  $('ov-cards').innerHTML=[['CPU',(s.cpu??'—')+'%','负载 '+(s.load??'—')],['内存',(s.mem??'—')+'%',''],
    ['今日任务',todayJobs,'失败 '+Object.values(d.jobs.kinds).reduce((n,k)=>n+k.fail,0)],
    ['在期订阅',d.issued.active,d.issued.total?('共签发 '+d.issued.total):'未挂载账本'],
    ['累计收入','¥'+d.issued.revenue,''],['磁盘',(s.disk??'—')+'%','']]
    .map(([k,v,x])=>`<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${x}</div></div>`).join('');
  const h=d.system.history;
  if(h.length>1){const xs=h.map((p,i)=>i/(h.length-1)*960);
    const grid=[37,75,112].map(y=>`<line x1="0" y1="${y}" x2="960" y2="${y}" stroke="#1C2634"/>`).join('');
    const line=(key,c)=>`<polyline fill="none" stroke="${c}" stroke-width="2" points="${h.map((p,i)=>xs[i].toFixed(1)+','+(146-p[key]*1.42).toFixed(1)).join(' ')}"/>`;
    $('chart').innerHTML=grid+line('mem','#5DA9FF')+line('cpu','#3FD68F');}
  const kindRow=(k,v,full)=>`<tr><td>${esc(k)}</td><td>${v.today}</td><td>${v.week}</td><td class="${v.fail?'bad':''}">${v.fail}</td><td>${dur(v.avg_ms)}</td>${full?`<td>${dur(v.p50_ms)}</td>`:''}<td>${dur(v.p95_ms)}</td></tr>`;
  const kindsHtml=(full)=>Object.entries(d.jobs.kinds).map(([k,v])=>kindRow(k,v,full)).join('')||'<tr><td colspan="7" class="muted">暂无任务</td></tr>';
  $('ov-kinds').innerHTML=kindsHtml(false);$('jb-kinds').innerHTML=kindsHtml(true);
  const recRow=(e,detail)=>`<tr><td class="muted">${fmt(e.ts)}</td><td>${esc(e.kind)}</td><td>${esc(e.caller.replace('pro:',''))}</td><td>${dur(e.ms)}</td><td class="${e.ok?'ok':'bad'}">${e.ok?'成功':'失败'}</td>${detail?`<td class="muted">${esc(e.detail||'')}</td>`:''}</tr>`;
  $('ov-recent').innerHTML=d.jobs.recent.slice(0,6).map(e=>recRow(e,false)).join('')||'<tr><td colspan="5" class="muted">暂无记录</td></tr>';
  $('jb-recent').innerHTML=d.jobs.recent.map(e=>recRow(e,true)).join('')||'<tr><td colspan="6" class="muted">暂无记录</td></tr>';
  $('mb-users').innerHTML=d.licensedUsers.map(u=>`<tr><td>${esc(u.email)}</td><td>${u.today}</td><td>${u.week}</td><td class="muted">${fmt(u.last)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">尚无付费用户调用</td></tr>';
  $('mb-issued').innerHTML=d.issued.list.map(i=>{const act=i.exp>Date.now();
    return `<tr><td>${esc(i.email)}</td><td>${i.iat?fmt(i.iat/1000):'—'}</td><td>${i.exp?fmt(i.exp/1000):'—'}</td><td>${i.price?'¥'+i.price:'—'}</td><td><span class="tag ${act?'g':'y'}">${act?'在期':'已到期'}</span></td></tr>`;}).join('')||'<tr><td colspan="5" class="muted">未挂载 issued.jsonl</td></tr>';
}

/* ---------- 推荐源 ---------- */
let FEEDS=[];
const TYPE_TAG={bilibili:['b','B站 UP 主'],rss:['p','播客/RSS'],article:['p','文章']};
function renderFeeds(){
  $('fd-rows').innerHTML=FEEDS.map((f,i)=>{const[c,label]=TYPE_TAG[f.type]||['p',f.type];
    return `<tr><td>${esc(f.name)}${f.group?` <span class="muted">· ${esc(f.group)}</span>`:''}</td>
    <td><span class="tag ${c}">${label}</span></td>
    <td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.region==='global'?'🌐 ':''}${esc(f.url)}</td>
    <td><button class="btn" style="padding:3px 9px" onclick="moveFeed(${i},-1)">↑</button> <button class="btn" style="padding:3px 9px" onclick="moveFeed(${i},1)">↓</button></td>
    <td><button class="tg ${f.enabled?'on':''}" aria-label="启用开关" onclick="FEEDS[${i}].enabled=!FEEDS[${i}].enabled;renderFeeds()"><i></i></button></td>
    <td><button class="btn danger" onclick="FEEDS.splice(${i},1);renderFeeds()">移除</button></td></tr>`;}).join('')
    ||'<tr><td colspan="6" class="muted">暂无推荐源，从上方添加</td></tr>';
}
function addFeed(){const url=$('nf-url').value.trim(),name=$('nf-name').value.trim();
  if(!url||!name){alert('地址和名称必填');return}
  FEEDS.push({id:'f'+Date.now().toString(36),name,url,type:$('nf-type').value,group:$('nf-group').value.trim(),region:$('nf-region').value,enabled:true});
  $('nf-url').value='';$('nf-name').value='';$('nf-group').value='';renderFeeds();}
function moveFeed(i,d){const t=i+d;if(t<0||t>=FEEDS.length)return;[FEEDS[i],FEEDS[t]]=[FEEDS[t],FEEDS[i]];renderFeeds();}
async function saveFeeds(){await j('/admin/api/feeds',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({feeds:FEEDS})});alert('已发布，全体用户下次启动即生效');}
async function loadFeeds(){FEEDS=(await j('/admin/api/feeds')).feeds;renderFeeds();}

/* ---------- 公版内容库 ---------- */
async function loadLibrary(){
  const d=await j('/admin/api/library');
  $('lib-usage').textContent=`库存储 ${mb(d.usedBytes)}`;
  $('lib-cards').innerHTML=d.collections.map(c=>{
    const files=c.files.map(f=>esc(f.name)).join('、')||'尚未上传文件';
    const total=c.files.reduce((n,f)=>n+f.size,0);
    return `<div class="lcard"><div class="lrow">
      <div style="min-width:0;flex:1"><h2 style="font-size:14.5px">${esc(c.title)}</h2>
        <div class="muted" style="margin-top:3px">${esc(c.source)} · ${esc(c.level)} · ${c.files.length} 个文件 · ${mb(total)}</div></div>
      <span class="tag ${c.published?'g':'y'}">${c.published?'已发布':'草稿'}</span></div>
      <div class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${files}</div>
      <div class="lfoot">
        <span class="sw">试听<button class="tg ${c.preview?'on':''}" onclick="patchCol('${c.id}',{preview:${!c.preview}})"><i></i></button></span>
        <span class="sw">免费可生成<button class="tg ${c.freeGen?'on':''}" onclick="patchCol('${c.id}',{freeGen:${!c.freeGen}})"><i></i></button></span>
        ${c.freeGen?'<span class="tag y">样例课 · 转化入口</span>':'<span class="tag p">Pro 解锁生成</span>'}
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
          <label class="btn" style="cursor:pointer">上传文件<input type="file" hidden multiple onchange="uploadFiles('${c.id}',this)"></label>
          <button class="btn" onclick="patchCol('${c.id}',{published:${!c.published}})">${c.published?'下架':'发布'}</button>
          <button class="btn danger" onclick="if(confirm('删除合集与全部文件？'))delCol('${c.id}')">删除</button></span></div>
      <progress id="pg-${c.id}" max="100" value="0" style="display:none"></progress></div>`;}).join('')
    ||'<div class="muted">还没有合集，先在上方新建</div>';
}
async function createCollection(){const title=$('nc-title').value.trim();if(!title){alert('合集名称必填');return}
  await j('/admin/api/library',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({title,source:$('nc-source').value.trim(),level:$('nc-level').value})});
  $('nc-title').value='';loadLibrary();}
async function patchCol(id,patch){await j('/admin/api/library/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});loadLibrary();}
async function delCol(id){await j('/admin/api/library/'+id,{method:'DELETE'});loadLibrary();}
function uploadFiles(id,input){
  const files=[...input.files];if(!files.length)return;
  const pg=$('pg-'+id);pg.style.display='block';
  const fd=new FormData();files.forEach(f=>fd.append('files',f));
  const xhr=new XMLHttpRequest();
  xhr.open('POST','/admin/api/library/'+id+'/files');
  xhr.upload.onprogress=(e)=>{if(e.lengthComputable)pg.value=e.loaded/e.total*100};
  xhr.onload=()=>{pg.style.display='none';if(xhr.status>=300)alert('上传失败：'+xhr.responseText);loadLibrary();};
  xhr.onerror=()=>{pg.style.display='none';alert('上传失败：网络错误');};
  xhr.send(fd);
}

async function loadAll(){try{await loadStats();await loadFeeds();await loadLibrary();}catch(e){console.error(e)}}
loadAll();setInterval(()=>loadStats().catch(()=>{}),15000);
</script></body></html>"""
