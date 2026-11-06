# 技术设计（r2）

## 当前修复：同页沟通弹窗已发送识别，0.22.3（2026-11-06）

- ISS-031。真实职位直链页点击“立即沟通”后，BOSS在同页打开`.dialog-wrap.startchat-dialog`；发送消息位于`.startchat-dialog .message-list > li.message-item`，成功状态为`.status.success`，消息标识使用`id`，没有聊天页的`.item-myself[data-mid]`。
- `content.js`的发送证据扩展为两路：原聊天页仍按`.message-item.item-myself[data-mid]`；弹窗路径要求节点可见、状态成功、稳定`id`，并且本次`INITIATE_CHAT`在10分钟有效期内。弹窗路径只在用户点击后建立上下文，不把页面加载时已有的旧消息计入。
- 两种路径统一进入既有`CHAT_SENT`后台串行消费和公司记录队列；只比较结构标识和状态，不读取/保存消息正文，不新增权限、网络、存储字段或BOSS节点写入。
- 定向覆盖弹窗上下文、未发送不写入、成功消息写入、正文不落存储及原聊天页回归；`npm test`196/196、`npm run check`、`npm run build`通过，dist为0.22.3。真实Chrome弹窗点击和发送状态待验收。

## 当前修复：职位直链页公司识别，0.22.2（2026-11-06）

- ISS-030。真实岗位直链页的当前职位身份由`/job_detail/<id>.html`路由和详情内当前职位链接确认；精选职位位于`.more-job-section/.look-job-list`，不能进入`explicitKeys`，否则会把推荐岗位误当成当前职位冲突。
- `COMPANY_REGION`仍覆盖详情内部公司链接；新增页面级可见`.sider-company/.job-company/.info-company`候选，使位于`.job-detail`外层的侧栏公司区可被读取。隐藏`.smallbanner`继续由`visible()`排除，职位标题不会变成公司名。
- `.look-all/.link-more`及推荐区域从公司候选排除，避免“查看全部职位”覆盖真实名称。仍要求当前职位路由键、唯一公司键和名称证据一致；两个不同公司、名称冲突或不可见区域继续返回`current:null`，不新增按标题、推荐公司或法律全称猜名称的路径。
- 点击“立即沟通”沿用既有来源映射：可靠页面仅建立`INITIATE_CHAT`上下文，实际聊天页出现本账号发出消息后才写`contactSource:auto`；修复不改变这条沟通证据规则。
- `core/job-parser.js`的排除区域同步加入`.more-job-section/.omnibus-*/.look-job-list/.smallbanner`，避免岗位采集把推荐职位当成当前岗位链接；实际保存页回放得到当前岗位、薪资和公司均正确。
- 新增合成直链页回归样本、岗位采集字段回归和content/background联调；`npm test`195/195、`npm run check`、`npm run build`通过，dist为0.22.2。真实Chrome直链页、侧栏显示和聊天发送待用户验收。

## 当前修复：悬浮球改为显示本次岗位数，0.22.1（2026-11-06）

- 权威需求REQ-20261106-collection-floating-count/r4。`capture.summary`在返回累计`total`的同时，按当前会话`keys`与有效`job:`记录求交，返回`sessionCount`；读取失败时两者都不伪装0。
- `captureView`新增`sessionCount/countText`；球体使用本次数，悬停条保留累计`total/totalText`，并继续显示本次新增/更新/未成功和最近结果。采集态仍隐藏公司操作/提示音，单击不写公司记录。
- 不改岗位记录、公司记录、CSV、看板或权限；`keys`仍只存session，`sessionCount`只随FLOAT_STATUS摘要返回。
- 定向覆盖累计2/本次1时球体显示1、悬停累计2，以及既有暂停恢复/提示时效/声音回归；`npm test`191/191、`npm run check`、`npm run build`通过，dist为0.22.1。

## 当前变更：本次与全部岗位导出，0.22.0（2026-11-06）

- 权威需求REQ-20261106-export-scope/r1。`JOBS_START`为新会话建立`keys: []`；每次成功保存或更新岗位时把`job.key`去重加入会话键列表，仅存`chrome.storage.session`，失败不加入。暂停保留，重启新会话清空。
- `JOBS_STATUS`只向侧栏返回`sessionCount`，不返回岗位键清单；`sessionCount`为当前会话成功岗位去重数，用于“导出本次（N）”按钮状态。
- `JOBS_EXPORT`新增`scope: session|all`。`session`按`tabId`/当前活动标签和会话键过滤`jobs.list()`，保留最近采集时间倒序；`all`保持原全部快照。标签切换或会话缺失拒绝旧范围，返回0时不生成空文件。
- `panel.html`/`panel.css`/`collector.js`并列“导出本次（N）”“导出全部（M）”；暂停后本次可用，新会话本次归零；文件名分别带“本次/全部”。无新增权限、网络、岗位字段或公司记录写入。
- 定向覆盖本次/全部范围、暂停/新会话、会话键去重、两按钮状态、文件名和既有导出/采集回归；`npm test`191/191、`npm run check`、`npm run build`通过，dist为0.22.0。

## 当前修复：薪资提示精简与短时失败提示，0.21.1（2026-11-06）

- 权威需求REQ-20261106-salary-reminder-transient/r1。侧栏`collector.js`移除`salaryPending`聚合提醒；该统计仍用于`JOBS_STATUS`和CSV“待重新采集”，不删除岗位或改变薪资判断。
- 侧栏最近消息按`lastAt`限时：成功约5秒、失败/等待约8秒；过期后恢复运行/开始提示，失败“重试当前岗位”按钮随提示隐藏。没有新增点击关闭或持久化忽略字段。
- `core/jobs.js`在开始、继续读取、暂停、开始失败、等待、成功和失败时更新session `lastAt`，仍只存在session，不进入公司/岗位/CSV/看板/话术。
- `core/floating.js`的采集摘要同样按5秒成功、8秒失败/等待限时；过期错误不再标红或持续显示，采集统计和未成功数字继续保留。
- 定向覆盖历史提醒移除、失败提示显示与过期、重试按钮联动、侧栏/悬浮球一致及既有采集/声音回归；`npm test`190/190、`npm run check`、`npm run build`通过，dist为0.21.1。

## 当前变更：采集模式悬浮球显示采集摘要，0.21.0（2026-11-06）

- 权威需求REQ-20261106-collection-floating-count/r2已获开发确认。`capture.summary(tabId)`读取本标签页`job-capture:<tabId>`，只在`running`时返回摘要：累计有效`job:`去重数、本次added/updated/failed、最近`lastName`/note/error及`lastAt`；不返回岗位链接、描述、薪资、公司关联或话术。岗位总数读取异常返回`totalError`，不伪装0。
- `lastAt`仅在采集会话中记录成功、等待或失败结果时间，不进入公司/岗位记录、CSV、看板或话术。成功/等待提示在悬浮球显示约5秒；失败原因保留到下一次结果。
- `core/floating.js`新增`captureView`，仅当采集会话运行且当前标签页为前台时覆盖公司视图；`FLOAT_STATUS`仍要求当前顶层读取器、页面token/visitId/公司键和文档一致。采集摘要读取失败不回落为公司状态，避免误报。
- `floating.js`增加采集态渲染：球体显示累计数并使用中性蓝绿采集色，悬停条显示累计、本次统计和最近结果；隐藏公司名称/查看/沟通/撤销/提示音控件。采集态单击只展开，双击打开侧栏，拖拽与位置记忆保留。
- 采集态不播放公司提示音，并将当前公司提醒消费掉，暂停后不补播旧公司声音；暂停、结束或切换到其他未采集标签页后恢复公司视图。其他标签页采集摘要不串入当前页面。
- 定向覆盖开始/暂停、累计与本次统计、最近结果5秒过期、失败保留、统计读取失败不报0、其他标签页隔离、采集态单击不写公司、拖拽/双击和既有公司/声音回归；`npm test`189/189、`npm run check`、`npm run build`通过，dist为0.21.0。

## 当前变更：看板岗位总数与侧栏顺序，0.20.0（2026-11-06）

- 权威需求REQ-20261106-dashboard-job-count/r1已获开发确认。看板新增“已采集岗位”，复用`core/jobs.js`的`jobs.list()`有效记录去重总数，与侧栏“累计”同口径；不新增存储、网络、权限或岗位明细接口。
- 新增只读`JOBS_SUMMARY`：仅接受本扩展精确`dashboard.html`来源，返回`{total}`；不返回岗位名称、链接、描述、薪资或公司关联。`JOBS_START/PAUSE/STATUS/EXPORT`仍只接受panel，`JOBS_CONTEXT/SIGNAL`仍只接受BOSS顶层读取器。
- `dashboard.js`并行读取公司记录与岗位总数；公司记录读取失败沿用原错误态，岗位统计失败只把该指标降为“—”，不覆盖已成功的公司统计。看板同时监听`company:`和`job:`本机变化并刷新。
- `panel.html`仅调整板块顺序为“当前页面 → 打招呼话术 → 岗位采集 → 我的记录”，采集器仍绑定原元素与消息，无行为变化。
- 定向覆盖岗位总数、失败降级、看板来源授权拒绝、侧栏板块顺序和既有采集回归；`npm test`185/185、`npm run check`、`npm run build`通过，dist为0.20.0。

## 当前修复：薪资接口来源，0.19.1（2026-11-06）

- REQ-20261106-salary-source-fix/r1已获用户“确认”，限定覆盖r3初版禁网络/新增权限边界；新增webRequest，保留BOSS单域host，CSP connect-src只允许完整固定详情端点。仅`core/job-api.js`可fetch，其余模块继续禁网络，内容解析仍只读。
- 已只读核对BOSS公开静态前端：job页面将详情响应的zpData传入组件，组件读取jobInfo.encryptId与jobInfo.salaryDesc并经mixFont显示。没有取得真实登录API响应，当前严格按该显式结构取业务字段；未知结构/code非0/未知或编码薪资报失败，不遍历猜字段。
- webRequest只观察精确端点的BOSS顶层GET XHR，要求原站initiator、真实tabId/documentId及开启会话；用浏览器事件timeStamp与会话startedAt核对。记录before到completed的实际请求，防止开启后消费之前的请求；扩展自己的tabId/initiator不接受，按requestId去重，单标签仅保留最新请求并中止旧读。
- 独立职位导航可能先发请求、后安装document_idle读取器：只将实际观察到的请求暂留最多30秒；完成事件或当前可信快照可唤起待处理请求。真正fetch前和响应后均通过指定documentId的GET_JOB复核、前台/活动/非加载中、原URL/会话一致；一个真实请求最多重读一次，8秒中止，不重试构造URL，redirect:error。队列外执行网络，暂停不被慢接口阻塞；暂存期限结束、暂停、导航和关闭清理URL/控制器。
- 响应只保留公开岗位键与通过可读性校验的薪资在内存短缓存；按sessionId/documentId/href/确切jobKey与HTML绑定，最终沿原双快照及当前页复核后保存。API结果唤醒原token重新读取，避免DOM未变导致正确薪资永远不更新。API优先；无接口时明确可读DOM可回退，编码/未知不可写成成功。
- `job:`记录增加salarySource白名单字段，不改公司/话术结构。旧记录无需迁移：坏薪资可读取但不得作为新写入；导出标“待重新采集”并提示数量，重新打开同岗位可靠更新且保留首次时间。CSV末列“薪资来源”，接口JSON、Cookie/令牌、完整请求URL均不写入存储或CSV，错误固定为不含敏感信息的行动提示。
- 合成样本和模拟传输覆盖API schema、可读性、响应乱序、来源/会话/文档/焦点、导航先于读取器、暂停、重试、防自循环、旧数据及公司/话术保留；真实Chrome接口/权限/Excel等待用户验收。以下0.19.0及更早实现说明保留历史，网络限制以本节限定例外为准，其余约束继续。

## 前次实现：岗位采集与表格导出，0.19.0（2026-11-06）

- 权威需求REQ-20261106-job-collection-mode/r3已获“开始开发”批准。读取层`core/job-parser.js`仅在用户开启的会话内由content读取当前DOM，不重发旧接口；无新增权限/外部连接/业务DOM修改。原先不做岗位查重的约束已在AGENTS限定修订为允许岗位资料去重，不增加岗位行为状态。
- 身份证据：唯一可见详情、详情实际`/job_detail/…html`链接或独立职位URL，属性仅能与实际卡片链接核对，不据属性拼URL。选中意图、卡片标题/详情标题、多个详情/链接冲突均检查；公司沿用规范链接唯一键，未知不猜测。
- 资料字段只读限定在标题、薪资、岗位要求及描述区域；跳过script/style、隐藏节点、推荐、招聘者/聊天区域。DOM快照至少稳定350ms；已接受的A岗位切到B且描述仍相同时保持等待，提示独立职位页，避免新标题/链接配旧描述。真实页面样本的CSS可见性与当前端展示仍需用户验收。
- content独立岗位token不改变原公司page-state/visit语义；开启后仅传会话/token信号，后台拉取`GET_JOB`，写入前再次拉取同一完整快照，并复核活动标签、前台窗口、URL、documentId与会话。暂停、保存、重试、关闭在独立采集队列串行，不加入公司写入队列。
- `core/jobs.js`按`job:<public-id>`独立本机键存业务资料和firstCollectedAt/lastCollectedAt，字段白名单/长度/身份/时间校验，仓储队列避免并发覆盖。公司、话术、设置均不迁移；原公司RECORDS只读取company:前缀。
- 会话在`chrome.storage.session`的`job-capture:<tabId>`保存running/id/计数/最近token/反馈，后台休眠保留；标签页移除或导航至站外清理，浏览器重启由session生命周期结束。恢复读取器会只获取本标签页会话标识，不向内容脚本暴露岗位库、公司全量数据或话术。
- `JOBS_START/PAUSE/STATUS/EXPORT`只接受本扩展精确panel.html无tab来源；`JOBS_CONTEXT/SIGNAL`只接受本扩展BOSS顶层内容读取器。独立看板仅有`JOBS_SUMMARY`去重总数只读摘要，无岗位明细、写入或导出权限；其他扩展来源无访问权限。访问既有TRUSTED_CONTEXTS策略不变。
- CSV由后台读取全部有效岗位并只读关联当前公司记录，列名明确公司口径；未知关联显示未知。UTF-8 BOM、全字段引号及既有公式防护、多行描述、上海时间；岗位标识保留job:类型前缀避免Excel数值转换，不改公司CSV。
- `collector.js`作为侧栏独立模块管理开始/暂停、数量、可重试错误和导出；不重建话术或公司区，不新增筛选比较。manifest与单次恢复都加载job-parser，静态检查将新读取路径列入只读与禁网络检查。

## 当前变更：搜索结果点击即记看过，0.18.0（2026-11-06）

- `core/settings.js`定义独立本机键`settings:list-click-view`，默认关闭；侧栏“当前页面”区提供开关，保存失败回退并提示，不进入公司记录、CSV或话术。
- `parser.companyFromClick`只从用户点击的职位卡片读取唯一公司链接，排除按钮、操作区和冲突公司；匿名`javascript:;`、名称猜测和相邻详情均不产生身份。
- `content.js`在点击时记录待处理公司、职位键和时间；只有同一文档的详情状态达到`job-card-match`、同一`jobKey`和公司键后才发送`LIST_CARD_VIEW`。超过10秒未确认则放弃，避免详情慢加载误写其他公司。
- `page-state`快照增加原始`jobKey`；后台`LIST_CARD_VIEW`先读取开关，再要求活动/前台页、token、visitId、documentId、jobKey、公司键和`job-card-match`全部一致。通过`CONFIRM_LIST_CLICK`回读当前DOM复核后复用`visits.manual`，只写已查看并回传本次会话。
- 开关关闭时后台直接返回未记录；不改变列表自身查重、公司页自动记录、悬浮球、手动沟通、CSV、权限或BOSS业务DOM。真实Chrome点击时序和窄侧栏开关布局待验收。
- 0.18.0继续包含0.17.0的悬浮球拖拽与`floating-position`位置键；本次列表点击改动未改拖拽规则、位置存储或悬浮球手势。
- 145项整体检查及check/build通过，23个扩展文件逐字节/SHA256核对，package/lock/manifest/dist一致0.18.0。

## 当前变更：悬浮球拖拽与位置记忆，0.17.0（2026-11-06）

- 宿主改为固定`42×42px`锚点，使用视口左上角`x/y`定位；悬浮条改为绝对定位并围绕球展开。球在左半屏时条向右展开，在右半屏时向左展开；垂直位置按条高度和视口边缘动态调整，展开/收起不再改变球的位置。
- 使用Pointer Events接入拖拽：`pointerdown`记录起点，移动超过`5px`才进入拖拽；拖动时收起悬浮条并更新位置，`pointerup`/`pointercancel`结束并保存。拖拽结束后抑制约400ms内的`click`/`dblclick`，避免误触标记、撤销或打开侧栏；未移动的普通单击/双击保持原逻辑。
- 位置限制在`0..视口-42px`；窗口`resize`时重新计算边界。用户未自定义位置时继续使用右侧45%初始位置；已保存或拖动过的位置按绝对坐标保留。位置保存串行发送，避免快速连续拖拽时旧写入覆盖新位置。
- 位置仅保存本机`chrome.storage.local`键`floating-position`，后台新增受限`FLOAT_POSITION`/`FLOAT_POSITION_SET`消息，仍只接受BOSS顶级内容脚本；不进入公司记录、CSV、话术或沟通字段，不新增权限，不修改BOSS业务DOM。
- 141项整体检查及check/build通过，新增覆盖拖动、位置持久化、窗口缩放边界、保存失败提示、拖拽抑制点击和位置消息来源/参数校验。真实Chrome拖拽手感、悬浮条换边和用户端重载待验收。

## 当前修复：悬停悬浮球时球体下移，0.16.1（2026-11-05）

- 原因是宿主`position:fixed; top:45%`、`.wrap`使用`align-items:center`；`.strip`展开后容器高度增大，42px小球在更高容器内重新居中，顶部位移约`(条高 - 42px) / 2`。
- 宿主改为`top:calc(45% + 21px)`并加`transform:translateY(-50%)`：以球半径21px补偿容器高度，隐藏/展开时球顶都保持在45%；`.wrap`继续居中，悬浮条围绕球中心上下对称展开。
- 仅改悬浮层自有宿主样式，不改BOSS页面DOM、点击逻辑、数据、权限或记录格式。新增样式回归断言，137项整体检查及check/build通过，真实Chrome悬停视觉待验收。

## 当前变更：悬浮球单击、双击与撤销，0.16.0（2026-11-05）

- `floatingView`新增`canUndo`：仅当记录为绿色“本次已记录”、未沟通，且当前访问历史为`first/manual`时为真；60秒内其他标签页新记录、历史记录、已沟通记录不提供撤销。
- `floating.js`悬浮球单击延迟280ms，只接受`event.detail === 1`的真实鼠标单击；未记录职位执行`FLOAT_VIEW`，其他状态只展开悬浮条。`dblclick`清除待执行单击并只打开侧栏；键盘Enter/空格仍只打开。销毁时清理计时器。
- 绿色本次记录单击不删除，只展开并在条内显示“撤销本次记录”；`undo`按钮发送新增`FLOAT_UNDO`，由`floating.undo`复核活动/前台页面、token、visitId、公司键、documentId、实际记录和`canUndo`后，调用既有`visits.remove`删除并同步相关标签页`suppressed`。
- `FLOAT_UNDO`与`FLOAT_VIEW`一样只接受BOSS顶级内容脚本，并进入`serialContact`串行队列；不新增权限、数据字段、CSV或BOSS DOM写入。页面只读、公司页自动记录和既有沟通规则不变。
- 137项整体检查及check/build通过，真实Chrome单击/双击判定、展开撤销和删除效果待验收。

## 当前变更：职位详情悬浮条标记已查看，0.15.0（2026-11-05）

- `floatingView`新增`canView`：可靠职位详情（`job-card-match`/`job-company-link`）且本地无公司记录时为真。悬浮条按`canView`显示“标记已查看”，否则维持“标记已沟通”；已沟通仍隐藏。
- 点击“标记已查看”发送新增的`FLOAT_VIEW`；后台`floating.view`先走既有`current()`复核活动/前台页面、token、visitId、公司键、documentId，再要求`detailType: job`及可靠来源，随后复用`visits.manual`写入手动查看会话，不写`contactedAt/contactSource`。
- `FLOAT_VIEW`不使用`visits.recover`包裹`visits.manual`，避免同一串行队列自等待；由`serialContact`保证与沟通写入串行。成功后向内容脚本发`VISIT_RESULT`，悬浮条刷新为绿色“本次已记录”，按钮变为“标记已沟通”。
- 公司详情页仍由`canView:false`显示“标记已沟通”；列表、简称查询、无法识别、撤销公司页和已沟通状态保持原隐藏规则。权限、记录字段、CSV、话术和BOSS业务DOM不变。
- 135项整体检查及check/build通过，真实Chrome搜索结果按钮与写入待验收。

## 当前修复：全局侧栏收起，0.14.1（2026-11-05）

- Chrome 145起，`chrome.sidePanel.close({ tabId })`在仅全局侧栏打开时会拒绝；扩展图标打开通常是全局侧栏，悬浮球双击`open({ tabId })`打开的是标签页侧栏，导致同一收起按钮时好时坏。
- `FLOAT_COLLAPSE`改为同时发起`close({ tabId: tab.id })`和`close({ windowId: message.windowId })`，用`Promise.allSettled`汇总：任一成功即已关闭，不再依赖侧栏打开方式。两条都失败才抛出中文“侧栏未能关闭，请重试；页面悬浮条已保留”。
- 悬浮条仍先由`FLOAT_COMPACT`固定，再执行关闭；断连恢复、活动标签页/URL核对、旧版无`close`的`setOptions`分支及所有数据/权限边界不变。复制后收起共用同一后台路径。
- 134项整体检查及check/build通过，真实Chrome全局/标签页侧栏收起待验收。

## 当前变更：复制话术后收起侧栏，0.14.0（2026-11-05）

- 话术标题区新增`pad-collapse`开关与就地状态`pad-collapse-status`；“复制话术”改为更大的实心绿色胶囊。窄侧栏下动作区允许换行，不改变Chrome原生侧栏宽度。
- `core/pad.js`导出独立键`settings:pad-collapse-on-copy`；`panel.js`通过`chrome.storage.local`读取/保存布尔值，默认关闭，并监听同键变化与其他侧栏窗口同步。该设置不进入公司记录、CSV或话术正文。
- `pad.js`新增`onCopied`回调，仅在`clipboard.writeText`成功后且`field.value === text`时触发；复制失败、旧复制响应或复制期间文本变化均不触发。面板只有在本机开关为开启时才调用既有`collapseFloating()`。
- 收起复用原`FLOAT_COLLAPSE`：先让当前BOSS页固定悬浮条，再关闭原生侧栏；断连仍返回`FLOAT_RECONNECT_REQUIRED`，由用户点击“重新读取并收起”恢复。没有新增第二套关闭/注入逻辑，也不改BOSS业务DOM。
- 开关写入失败会恢复原选择并在控件下方提示再次切换；复制失败或文本变化时侧栏保持。权限、公司身份、记录、话术存储与CSV格式不变。
- 132项整体检查及check/build通过，真实Chrome视觉和复制后收起交互待验收。

## 当前修复：站内切换后的悬浮状态读取，0.13.7（2026-11-05）

- `FLOAT_STATUS`新增独立`read()`：只要求发送方为活动BOSS顶层内容脚本，`GET_PAGE`后用`tab.url`校验最新快照，再核对documentId、visitId和当前公司键；不把`sender.url`、`message.href`、`tab.status`作为只读状态的硬门槛。token不参与状态读取，避免同一公司DOM刷新导致误重试。
- `FLOAT_CONTACT`仍走严格`current()`链路：active、非loading、`message.href === tab.url`、token/visitId/key/documentId和前台窗口；仅移除与documentId/最新快照重复的`sender.url`字符串比较，避免SPA同文档路由切换误拒合法写入。
- 状态读取遇到页面切换返回`FLOAT_STATUS_RETRY`；悬浮条显示“页面正在更新，稍后自动重试”，沿用1.5秒轮询，不伪装成未记录或之前看过。记录字段、CSV、话术、权限和声音规则不变；129项检查及check/build通过，真实Chrome待验收。

## 当前修复：新公司绿色、历史重看红色，0.13.6（2026-11-04）

- `floatingView`新增`green`：`record && fresh && !waiting && !suppressed`为绿色；红色改为仅`record && !fresh && !waiting && !suppressed`。当前次沟通不再单独触发红色，而是绿色“本次已沟通”。
- `isFreshView`覆盖同一标签页`current-visit`的`first/manual`状态和创建60秒内的新记录；因此新公司、手动标记查看、手动/自动标记沟通都先进入绿色。超过60秒且没有当前会话，再次进入形成历史时才红色。
- 面板公司页和职位页使用同一`fresh`判断：当前次显示绿色`badge seen`（含“本次已沟通”），历史`prior`/旧记录才走红色`historical()`；红色历史仍显示首次查看/沟通时间。
- 悬浮球样式新增`.ball.green`/`.status.green`；声音继续以`red && !quiet`为准，绿色不响；新记录60秒内的`quiet`会消费当前encounter，避免之后转红时补响。记录字段、CSV、权限不变。
- 127项整体检查及check/build通过，22文件校验；真实Chrome颜色和文案待ISS-019验收。

## 当前修复：新添加公司60秒静音，0.13.5（2026-11-04）

- `records.js`新增`isRecentlyAdded(record)`，按`markedAt`判断任意记录是否创建于60秒内；不要求自动公司来源，因此手动新增/刚标记沟通也适用。
- `floatingView`返回`quiet`；红球/文案照常表示已沟通或历史，但声音`eligible`要求`red && !quiet`。`red && quiet`时将该次company encounter标记为已消费，避免同一停留到60秒后突然补响。
- 记录字段、60秒时间语义、CSV、权限和面板历史判断不变；重新进入其他公司或形成新encounter后，原提示音规则恢复。
- 128项整体检查及check/build通过，22文件校验；真实声音待ISS-018验收。

## 当前修复：历史提醒显示具体查看时间，0.13.4（2026-11-04）

- `core/records.js`新增`localDateTime(value)`，按Asia/Shanghai输出`YYYY-MM-DD HH:mm`；`localDate`继续用于文件名和CSV日期列。
- 面板的“之前看过/首次记录/首次查看/首次沟通”、可能记录列表、已看过列表和记录详情统一显示到分钟；悬浮球`floatingView`增加`seenAt`，悬停展开时显示“查看：…”，球标题同步。
- 未记录、无法识别、简称查询和公司页等待确认时不显示时间；已沟通状态仍优先显示，并显示对应首次查看时间。记录字段、`markedAt`首次时间语义、CSV字段和权限不变。
- 127项整体检查及check/build通过，22文件校验；真实Chrome悬停布局和时区显示待ISS-017验收。

## 当前修复：刚记录公司进入岗位页不提示历史，0.13.3（2026-11-04）

- 职位详情页没有自动查看`history`，面板与悬浮球原先只按本地记录判断，导致刚记录的公司显示“之前看过”并可能响铃。现统一通过`isFreshView(record, visit, recentAuto)`判断“本次已记录”。
- 先检查`recent-auto-companies`中同一公司的60秒自动记录标记，命中后不区分标签页、入口或当前会话；未命中时再读`current-visit:<tabId>`，仅自动公司页产生的`state: first`视为本次记录，`manual/prior/suppressed`不抑制历史。手动标记职位不写60秒标记，避免把真正的历史误判成刚记录。
- `visits.open`首次自动保存时维护`recent-auto-companies`（公司键→markedAt/at）并清理过期项，撤销时删除对应项；不改变local公司记录/CSV/话术，只是session临时元数据。面板、悬浮球与声音共用同一视图判断，红色不成立时不会播放提示音。
- 127项整体检查及check/build通过，22文件校验；实际Chrome颜色、文案和声音待ISS-016验收。

## 当前修复：公司“招聘职位”tab身份，0.12.1（2026-11-04）

- `companyIdentity`新增公司招聘职位路由：`/gongsi/job/<公司键>.html`及`/gongsi/job/<2-10位数字筛选段>/<公司键>.html`，统一返回原公司简介URL和`boss:<公司键>`；拒绝非数字筛选段、尾斜杠、`/gongsi/jobs/`及外部来源。
- `createPageState`继续以规范化公司URL作为route，同公司从“公司简介”切到“招聘职位”不产生新visit；名称尚未加载时只显示无法识别，不按名称写入，页头名称出现后在同一visit触发自动记录。
- 公司页解析将`.similar-job-wrapper/.similar-job-list/.similar-job-card`加入推荐区排除，当前公司冲突检查不读取相似职位卡片里的其他公司链接。职位详情/list逻辑不变，仍不自动写入。
- 新增合成`company-jobs`样本及真实“百济神州招聘”HTML只读回放；119项整体检查通过，真实Chrome记录与立即沟通链路待ISS-013验收。

## 当前变更：②双音提示，0.12.0（2026-11-04）

- core/sound.js于ISOLATED读取环境本机合成AudioBuffer（660/880Hz双音、0.55s），无需音频资源/网络或新权限。manifest与恢复脚本都在floating之前加载它。
- createSound保留读取器shared.soundEncounter（单个公司键、是否已提醒、代数）；可靠其他公司或明确列表重置，短暂未知不重置，同公司token/沟通状态变动不重响。只用内存，不保存更多浏览历史。
- FLOAT_STATUS返回soundEnabled与窗口聚焦许可；声音另检查当前页面可见/焦点、当前可靠键/token、代数及撤销状态。异步resume前后复核，不排队播放旧公司。停用/切换/失焦/隐藏时停止节点，读取器销毁关闭上下文，恢复沿用去重。
- AudioContext非running不当作已播放；悬浮条常驻音效开关，受限另显示“启用声音/重试启用声音”。用户点击内同步resume，成功running后才尝试提醒；受限状态也能直接关闭。FLOAT_SOUND_SET仅可信BOSS顶层读取器，核对当前快照及布尔值后后台写sound-enabled；不开放内容脚本storage权限，不动公司/话术/CSV。
- 116项确定性检查及19文件构建通过；实际Chrome声音策略/音量/听感未验收，ISS-012开放。

## 当前修复：收起断连恢复，0.11.1（2026-11-04）

- FLOAT_COLLAPSE缺接收端时返回FLOAT_RECONNECT_REQUIRED及tab/URL恢复目标，不在该消息中注入、不提前关侧栏。其他通信失败返回中文保留提示。
- panel新增“重新读取并收起”显式重试动作；reconnectPage返回成功/失败，并在读取前核对原目标，成功才再发送绑定tab/URL的收起。收起消息发送后再次核对活动标签，避免切换期间关错；后台恢复仍沿既有READ_PAGE校验及不确定查看抑制。

## 当前变更：悬浮球与精简条，0.11.0（2026-11-04）

- 用户批准仅新增一个自有宿主（closed Shadow DOM），floating.js负责节点、样式、交互与销毁，读取器仍不改业务节点。manifest常规加载和手动恢复均加载floating.js，沿用读取器单例/轮询，失效上下文销毁浮层和监听。
- FLOAT_STATUS从可信顶层BOSS读取器请求当前公司视图，不开放全量记录给内容脚本；后台核对活动页、href/token/visitId/documentId与公司键。FLOAT_CONTACT共用沟通串行队列、visits恢复锁与repository写入队列，存储前再次确认身份/焦点/撤销状态。旧MARK_CONTACTED面板权限不放宽。
- first/manual本次记录普通色，prior或其他历史记录整球红色，contacted优先红色；公司自动记录尚未返回时中性等待，避免存储已保存而history未回传导致瞬时误红。query/list/未知不显示确定历史或写入入口。
- 悬停/键盘聚焦展开条，点击沟通才写入；双击球在消息接收的同一手势轮次直接调用sidePanel.open。panel“收起为悬浮条”先让当前标签固定展示条，再关闭原生侧栏；Chrome支持close时使用close，旧版setOptions禁用再恢复同tab，不提升最低116版本、不导航BOSS。Escape收回固定条。
- 原存储结构/权限/CSV与数据边界不变。新旧关闭接口、真实页面布局和双击手势仍需Chrome验收，ISS-010跟踪；静态球试用反馈不能证明风控安全。

## 当前变更：当前页面标记已沟通，0.10.0（2026-11-03）

- panel在“当前页面”区，仅当快照携带可靠公司身份（公司详情或可靠关联职位详情，unknown/query/list提前返回）且记录未沟通时显示“标记已沟通”，复用updateContacted与后台MARK_CONTACTED手动链路；公司页本次已撤销（suppressed）不显示，避免与撤销抑制语义冲突。
- 未记录公司直接标记时由repository.markContacted创建已看过+已沟通记录；已记录公司保留首次查看时间。按钮与记录操作共用operation忙锁，失败重试目标不变；成功后当前提示、记录列表与CSV同步，取消入口仍在我的记录。
- 88项检查通过；真实Chrome按钮布局与操作待验收。下方历史版本记录按当时状态保留。

## 当前变更：取消已沟通，0.9.0（2026-11-02）

- repository.cancelContacted与保存/纠名/撤销共享原串行队列，验证原记录后仅删除contactedAt/contactSource，保留原始其他字段。已取消重复调用幂等，缺记录不新建，异常或保存失败保持原数据；取消不改变休息制度更新与首次查看会话。
- CANCEL_CONTACTED仅来自可信panel.html，按存储公司键操作已有记录。后台新增沟通串行队列，发起沟通、opener继承、消息消费、手动标记、取消与标签关闭清理共用；取消先清除同公司各标签页的待消费session上下文，再保存取消状态。session失败时不宣称成功，local保存失败时原标记保留、允许重试，已清理的旧上下文不会重新绑定。
- 读取器用既有item-myself气泡的data-mid内存集合替代总数比较，重新发起沟通前记住当前气泡。旧气泡克隆/重排不再发信号，数量不变但出现新标识仍能识别；data-mid延后赋值由观察器与原轮询覆盖。同文档读取器恢复通过shared保留去重集合，标识不发送给后台、不落local/session/CSV，不读取消息正文。无来源上下文的事件仍不能按简称或会话文字补记。
- 面板按钮相同位置显式标记/取消，发送目标状态而不是再次反转，重试保持相同目标。操作中禁用记录相关按钮；记录读取有请求序号，迟到的旧响应不能恢复取消前的显示。保存成功重读，当前公司区、记录列表、简称候选与CSV均以最新记录更新。
- 新的首次公司查看/主动职位记录同样优先显示已有沟通状态，取消后恢复其first/manual/prior状态。撤销仍删除整条记录，文案与取消明确区分；话术及高度独立存储，无数据迁移或新增权限。
- 38项定向和86项整体检查通过，build内嵌静态检查与16文件字节/摘要通过，源码/lock/产物版本0.9.0。真实Chrome界面、消息加载和跨标签页生命周期待ISS-008验收；下方各历史版本记录按当时状态保留。

## 当前变更：公司简称模糊查询，0.8.0（2026-11-02）

- parser优先处理可见chat-conversation，读取top-info-content内base-info的公司span和chat-position-content的position-name；排除联系人姓名与身份。选中friend-content的公司与头部冲突、头部缺公司或多个可见会话时清空简称。没有会话时仍可从公司专属标题/属性、精确职位关联区域提取nameHint，不按高亮样式猜测当前公司。
- query快照不携带可写公司身份：page-state强制current为null、companies为空、无查看和休息制度状态，detailType为job。nameHint/jobHint仅用于页面证据和只读展示；展开会话优先级避免背景公司页触发自动记录或名称纠正。content没有因query建立沟通来源或发送自动查看/休息制度请求。
- core/records.js的fuzzyMatchRecords只读查询有效记录，不调用repository写入。名称统一NFKC、大小写、空格/标点和常见法定后缀；相同名称优先于简称包含，至少四字符才允许单字符差异。过滤通用/过短名称，最多三条；相同名称的不同公司键分别保留，不形成身份映射。
- panel显示黄色“可能看过”、查询简称/岗位及候选原名称、链接、首次查看日期。候选沟通状态注明“该记录已标记沟通”；查询结果没有已查看/已沟通写入入口。无匹配和读取失败分别反馈；切换时清除旧候选与样式。
- 查询不更改公司键、URL、首次时间、历史名称或话术。可靠公司详情页的既有自动记录和可靠职位的主动记录保持原规则；公司简称本身不是任何写入证据。真实样本只在temp-evidence本地分析，正式回归使用合成结构。
- 76项检查与16文件构建通过，package/lock/manifest/dist为0.8.0；实际Chrome动态页面与视觉待验收。下方历史版本的模块、权限及行为说明按当时版本保留，以本节和最新已批准需求为准。

## 最新修复：ISS-004 / OPT-006，公司名称，0.5.1（2026-10-15）

- companiesIn旧fallback及公司页heading直接textContent会拼入后代操作；改只读递归遍历，跳过button/role=button、操作class与隐藏节点，不按“收藏”词汇替换，不修改DOM。优先唯一专属名称节点与明确company-name属性；title需与可见过滤文本一致或无操作纯空内容，避免把操作tooltip当名字。合法“收藏文化有限公司”保留，纯混合字符串缺证据不截尾。
- 结构可靠的解析结果携带临时nameProof，存储仍仅原公司格式。冲突名称不提供纠错证据。repository.correctName仅纠正已存在、有效且同键记录的name；保存原URL、key、markedAt和其他原字段，不创建未知或已撤销记录。已有visit及同visit缓存也可纠错，原first/manual/suppressed状态不变。
- 面板收到新证据时按tab/href/token去重发起SYNC_COMPANY_NAMES；后台只接受可信panel.html，重新读取顶层快照并核对前台窗口/标签、URL、token和每个名称来源，写入前再确认。与公司保存/撤销串行，无新增权限，不信任请求中的名称，无证据不写入。读写失败保留原记录，面板提示可重试。
- nameProof不进入local公司记录、CSV或话术数据；storage变化更新搜索/导出显示。真实截图DOM未取得，已用合成结构证明代码路径与修复，尚未证明实际BOSS页面已适配。更新原扩展并重新读取后由用户验收，ISS-004保持开放。

## 当前变更：REQ-20261011-page-reconnect/r1，0.5.0

- 增加scripting权限，保留单BOSS host权限，按[Chrome scripting官方接口](https://developer.chrome.com/docs/extensions/reference/api/scripting)使用顶层frameIds:[0]、ISOLATED和固定本地文件；documentId用于注入后消息定向。同源可信panel.html的READ_PAGE才能执行，不开放内容脚本恢复请求或用户指定脚本。
- 先GET_PAGE，只有精确无接收端/Extension context invalidated错误才注入一次；普通解析unknown、错误快照、端口关闭等不明确错误不注入。后台每标签锁，当前窗口/前台标签/URL/非加载校验在异步边界前后重做。读/注入/恢复失败结束忙状态；普通轮询仍只读取。
- 恢复与公司写入/撤销共享visits串行队列，恢复启动先冻结自动写入；注入结果和后续快照token、documentId匹配后才恢复状态，避免恢复途中切页自动记错。首次/手动session增加临时documentId/href，不改公司local格式。恢复中途失败保持只读，下一次明确点击可完成状态确认，无额外注入。
- 内容读取器隔离单例：健康重复执行直接复用；失效读取器释放observer、timer、DOM/window/runtime监听，并拒绝旧异步响应，复用同文档page-state和history。持有旧runtime引用检测失效，轮询时也主动销毁。0.4.x没有单例/销毁接口，无法从新世界证明清理旧Chrome上下文；这是ISS-001真实升级验收边界，未声称已验证。
- 当前文档单例history或documentId/href/公司键均匹配的session才复用visitId。无证据时只查重，既有local显示prior；当前公司visit保存recoveryBlocked临时状态，不写公司记录、不让重读/面板重开/普通轮询解除。真正离开形成新visit才恢复auto；撤销串行抑制同样保持。未知公司页头部未加载也保护当前visit。
- 页面读取器不写BOSS DOM，不导航/刷新、不读聊天；侧边栏话术输入不重建。恢复权限与同文档缺证据降级已获r1及产品DEC确认，不增加local检查点或其他权限。
- 本地构建15文件。源码/模拟Chrome与生命周期检查不代表真实Chrome恢复、滚动保持、旧上下文清理或视觉验收；旧版本设计保留于下方。

## 最新修正：DEC-pad-r1-NATIVE-RESIZE-20261011，0.4.2

移除独立按钮及其pointer/keydown逻辑，textarea使用resize:vertical和80–480px/动态视口max-height，width/max-width固定100%。ResizeObserver仅在浏览器原生缩放改变inline height、且不同于最近程序设置值时更新期望高度并保存；程序恢复/视口变化只更新展示值，观察回调不写入，不污染原期望高度或循环保存。文本方向键保持原行为；话术保存/复制及公司数据不变。原生Chrome拖动与布局未验收；下方旧手柄设计保留版本历史。

## 最新修正：DEC-pad-r1-QUIET-20261011，0.4.1

正常读取/保存完成调用空状态并隐藏整个pad-meta，避免空行占位；保存中、未保存、失败/冲突仍展示。手柄只显示简洁符号，保留aria-label、pointer及键盘高度功能。没有改动存储、复制或公司逻辑；实际视觉未验证。

## 当前变更：REQ-20261011-record-collapse-message-pad/r1，0.4.0

- 记录默认按原repository倒序结果展示3条，toggle是面板临时状态。搜索展示全量匹配，输入或清空搜索重置折叠；CSV仍调用完整records，不更改公司键/格式/首次时间。
- 话术textarea独立于当前公司和记录的render，页面刷新与记录事件不重建输入。独立storage.local键settings:message-pad保存text、height、revision、writer、sequence；仅可信panel.html可通过PAD_READ/PAD_SAVE访问，BOSS内容脚本不可读取话术，存储仍为TRUSTED_CONTEXTS。
- 每次输入立即发起后台请求，不使用面板内防抖或等待上一响应后才发送下一输入，减少即时关闭面板时最新输入尚未发送的窗口。后台串行写入、读格式校验和revision比较；只有同一writer未被其他窗口覆盖的连续sequence可以在基线尚未响应时继续保存。旧sequence、未来revision或其他writer旧revision拒绝。
- 保存响应只更新基线，不改textarea；仅最新请求更新保存状态。远端新修订在本地干净时自动采用，有未保存输入/待响应请求时保留本地并提示冲突。明确“保留我的内容”后使用最新基线提交；延迟的旧成功不能消除更新的远端冲突。错误保留输入，提供重试。
- Clipboard API只在用户复制点击中调用writeText，取当前文本而不是已存基线；异步请求序号防止旧成功盖住新失败，成功后才反馈，失败可重试/手动选择复制。没有clipboardRead/clipboardWrite新增权限，不读取剪贴板。
- 可见pointer手柄在纵向调整textarea，pointer结束/取消保存高度；上下键可操作。80–480px并限制至视口高度减240px、最低80px；视口变化仅调整展示，不覆盖持久期望高度，横向width100%/wrap与resize:none不引入宽度控制。真实Chrome布局、拖动和复制未验证。
- 0.4.0共13个扩展文件；所有公司行为保留，下方0.3.0/0.2.0内容作为对应版本历史。

## 当前变更：REQ-20261011-manual-mark-emphasis/r1，0.3.0

- 职位详情允许可信侧边栏“标记已查看”按钮请求 MARK_JOB_COMPANY；只接受本扩展 panel.html 无 tab 的来源。BOSS 内容脚本、其他扩展、其他扩展页及旧 MARK_COMPANY 入口不能请求主动写入；公司页自动入口保持独立。
- 当前展开职位生成稳定 visitId；仅 job-card-match/job-company-link 可靠公司来源可确认。后台核对窗口、前台标签、href、token、visitId、当前公司键，保存前再次确认，内容响应返回后再次检查活动页面。不新增站点权限或业务 DOM 写入。
- 本次主动新保存的 session 状态为 manual，已有记录为 prior，首次时间不变；同次展开/存储通知/后台重建不会把新保存变为历史。离开再展开或刷新文档产生新查看身份。撤销的 suppressed 状态优先于面板旧保存结果；职位不会自动重记，允许再次主动点击。
- 浅红 #fff1f2 背景、深红 #8c252f 文案仅应用于当前历史公司 section。明确文字和首次日期同时表达历史；记录列表与列表查重维持中性。样式声明/状态结构已检查，实际 Chrome 视觉未验收。
- 未知来源、无法识别、数据读取失败不出现可写入口。写入失败不显示成功并提供重试；旧上下文重试仍须重新通过页面身份确认。
- local 键与公司格式、CSV/搜索、原 dist 路径保持不变。下方 0.2.0 与 0.1.0 内容是历史记录，关于移除所有手动入口的描述仅适用于当时版本。

## 当前变更：REQ-20261011-detail-auto-history/r2，0.2.0

- 原0.1.0手动写入入口已移除；列表与职位详情始终只查重。规范公司页 URL、唯一名称及无冲突公司身份才触发自动记录，后台仅接受来自 BOSS 顶层内容脚本的请求，不接受侧边栏或职位页请求写入。
- 后台再次检查活动标签、窗口在前台、非加载中、公司 URL、公司键、文档 token、visitId 和 content 再确认快照；本地写入前再次确认。无新增权限或网络获取。
- 职位可经专属公司区链接，或详情明确职位键（规范职位链接/显式data-job-id/data-jobid/data-encrypt-job-id，精确值匹配）与卡片链接一致后查重。只读点击意图仅用于排除新点击与旧详情冲突，不能单独证明公司。推荐区、隐藏详情、冲突键均排除。
- 上述内联 DOM 字段支持只有合成样本证据，未获取真实登录字段；两条路径都缺可靠依据时仍无法识别。没有独立名称清洗改动或新权限依赖。
- 查看结果通过 storage.session 保存每个标签当前 visitId、公司键、首次/历史/撤销状态和日期，浏览器/扩展重启时清理；公司持久记录仍是原 storage.local 的 `company:boss:<id>`，格式与首次时间不变。
- 同次公司页打开的首访标记不因后台重启或存储通知改变；关闭/离开重开产生新visitId。有记录返回历史，当前页撤销先保存抑制状态、再删除记录，成功后推送内容脚本，延迟旧响应不能覆盖撤销状态。
- 公司页路由切换但身份 DOM 尚未改变时等待；解析暂时缺字段不结束同页visitId。只改变追踪query/hash不当作重新打开。后台标签/窗口只读取不写入，进入前台后重试。
- 0.1.0研究与设计历史保留于下方，手动触发描述不再作为当前行为。

## 识别证据与边界

2026-10-10 开发使用普通 HTTP 只读读取 BOSS 公共首页（不登录、不模拟浏览器、不绕过验证），响应 200，找到 81 个不同 `/gongsi/<标识>.html` 链接；推荐职位结构含 `.sub-li`、职位链接及公司 `.user-info .name`。这仅证明公共首页存在公司链接，不证明标识永不变化或登录页面一致。

两条只读获取路径已尝试：

1. 页面内公司专属链接：公开首页可取得；首页链接的职位详情响应未含公司链接。
2. 详情中的显式公司身份属性：上述响应未找到 `data-company-id` 或 `data-brand-id`；公司页返回安全验证内容。

因此不推断聊天/登录数据、不读取应用内部状态、不拦截接口、不按名称合并、不绕过验证。第一版仅接受页面实际存在的规范公司链接，或公司页面当前 URL；详情须在专属公司区域找到唯一公司键。登录页面适配与真实跨职位关联未验收。缺少身份或出现冲突时禁用标记并显示无法识别。

## 模块与权限

- Manifest V3，最低 Chrome 116；原生 sidePanel。权限仅 `storage`、`sidePanel`，站点仅 `https://www.zhipin.com/*`；不申请 tabs/scripting/webRequest/downloads 权限。
- 内容脚本只读取 DOM、监听相关变动和路由变化，向扩展发送当前页最小公司快照；无网络抓取、无写入页面节点、无点击/发送操作。列表只读取已加载职位卡片。
- 公司键为 `boss:<公司链接路径标识>`，忽略链接 query/hash。同名不同公司键不合并；未取得键不能标记。显示名仅用于展示和搜索。
- 后台串行写入 storage.local，按公司键单独保存，防止多窗口覆盖整表；仅扩展可信上下文访问记录存储。成功写入才返回成功，错误不伪装空表或成功。
- 侧边栏随当前活动标签页更新；请求序号和页面 token 防止旧响应覆盖新页面。操作前重新获取该页快照，拒绝切换后的旧公司标记。SPA URL 切换而公司 DOM 尚未更新时清空旧快照并等待变化；若内容长期不变，提示刷新后重试。
- 不跨窗口展示其他窗口的活动页；离开 BOSS 时清空当前页状态，全部记录仍可查看。
- 展示用 textContent，链接限定 BOSS 公司 URL，CSV 全字段引用并对公式开头文本加单引号，UTF-8 BOM；文件名与日期显示按 Asia/Shanghai，存储为 UTC。
- 运行无第三方依赖；开发 DOM 样本使用 linkedom，Node 自带 test runner。静态检查限制权限、远程脚本、页面写入/网络/自动化行为；构建复制 extension 到 dist/boss-helper，不启动浏览器。

## 已知限制

原生侧边栏需要首次点击扩展图标打开。现有 BOSS 标签页安装扩展后需刷新加载内容脚本。移除扩展会删除本地记录，导出仅供查看，第一版无恢复导入。用户手动加载与登录后最短验收路径写于 README，本轮不执行。

## 0.6.0 已沟通与休息制度

- core/rest.js：公司页可见文本（排除按钮/推荐区/隐藏节点）单值分类双休/单休/单双休；冲突或缺失为null，不落任何默认值。快照经validateSnapshot仅透传合法枚举。
- 公司记录新增可选字段contactedAt/contactSource(auto|manual)/rest/restUpdatedAt；validRecord丢弃畸形字段；markContacted存在则保首ContactedAt（manual不覆盖auto首次），不存在则以沟通时间建记录；setRest仅更新已有记录。CSV末尾追加首次沟通/来源/休息制度列。
- 来源映射：content只读监听“立即沟通/继续沟通”点击，可靠详情身份时向后台INITIATE_CHAT；后台session按tab存上下文；聊天页首个.message-item.item-myself上报CHAT_SENT，后台消费上下文markContacted(auto)后立即删除；标签页关闭同步清理。上下文只存session，不落local。
- 已知边界：消息列表直开旧会话无来源不记录；聊天页DOM无公司键（temp-evidence取证），不做名称匹配；发送中/失败状态不区分（用户决策：有送出即算）。
