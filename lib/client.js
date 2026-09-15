window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-prompt-optimizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOM = require("react-dom");
		/* 官方 UI 基元（shell 提供的静态模块）：菜单、图标、锚定/关闭钩子。
		   头部那一枚胶囊与它弹出的纵行菜单全部由这些基元搭出来 —— 天然与 DSH 自己的
		   菜单/胶囊同款（扁平、无渐变、同一套设计变量），也不会随主题改版走样。 */
		const UI = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;

		const API = "/prompt-optimizer/api";
		const NS = "dsh-prompt-optimizer";
		/** 客户端侧目录缓存有效期（宿主侧另有 30s 缓存，这里避免频繁打网络）。 */
		const CATALOG_TTL_MS = 60 * 1000;
		/* 单例闸门：插件包会被 HMR 重新求值，旧实例的监听若尚未回收就会"替新实例干活"——
		   结果是旧实例拦截了发送、跑起了优化，但它的 UI 早已卸载 ⇒ 后台在跑、弹窗不显示。
		   这里让每个实例在 apply 时抢注 token，只有持有 token 的实例才有权拦截与渲染。 */
		const INSTANCE_TOKEN = NS + "#" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
		const isActiveInstance = () => {
			try { return window.__DPO_ACTIVE__ === INSTANCE_TOKEN; } catch (e) { return true; }
		};
		const MARK = "data-dpo";

		/* ══════════ 模块状态（P0 骨架：只服务于"手势拦截实测"） ══════════ */
		const store = {
			armed: true,
			tier: "basic",
			permission: "review",
			/* 上下文（上游 0.1.9 的功能）：优化时读入最近多少回合（0~10）。
			   historyMode="full" 时改读全文，fullOn 是全文的关/开。
			   三者都会随配置落盘，并随 /run 一起交给宿主。 */
			turns: 0,
			historyMode: "turns",
			fullOn: false,
			modelLabel: "会话默认",
			modelSel: null,
			modelCatalog: null,
			modelCatalogAt: 0,
			modelCatalogLoading: false,
			modelCatalogError: null,
			modelCatalogPromise: null,
			/* 头部的纵行菜单是否展开（唯一弹层；旧的模型/帮助两个浮层已合并进它）。 */
			menuOpen: false,
			/* 输入框那份（胶囊 + 隐形锚点）是否已注册 —— 防 list 槽重复 id。 */
			captureRegistered: false,
			/* 提示词收藏夹。favorites=null 表示"还没拉过"，避免把空数组当成已加载。
			   favEditId / favConfirm 是逐条的临时态（重命名中 / 待确认删除）。 */
			favorites: null,
			/* 注：收藏夹搬进右侧栏后，开合由侧栏的 tab 管理，这里不再需要 favOpen。 */
			favQuery: "",
			favLoading: false,
			favError: null,
			favBusy: false,
			favEditId: null,
			favEditText: "",   // 编辑中的标题
			favEditBody: "",   // 编辑中的正文
			favConfirm: null,
			/* 注：provider 的模型现在走官方子菜单，不再需要"展开态"这份状态。 */
			/* 拦截卡：是否已注册/已挂载（同上）；展开态 null＝按状态自动决定。
			   thinkOpen/traceOpen 是两个折叠区（思考 / 查证动作）的展开态。 */
			/* 右侧栏 tab 是否已注册（幂等闸门） */
			sidebarRegistered: false,
			dockRegistered: false,
			dockMounted: false,
			dockOpen: null,
			thinkOpen: false,
			traceOpen: false,
			node: null,
			overlay: { open: false, text: "", src: "" },
			reviewText: null,
			regenAsk: false,
			regenDir: "",
			touched: false,
			intercepts: [],
			listeners: new Set(),
			latest: { input: null, session: null, actions: null, sessionId: undefined },
			viewSessionId: null,
			stash: {},
			tierBySession: {},
			permissionBySession: {},
			helpOpen: false,
		};
		const TIERS = [
			{ id: "off", label: "关闭" },
			{ id: "basic", label: "普通" },
			{ id: "advanced", label: "高级" },
			{ id: "extreme", label: "极端" },
		];
		const PERMISSIONS = [
			{ id: "review", label: "审查" },
			{ id: "auto", label: "自动" },
		];
		let noticeTimer = 0;
		function showNotice(text) {
			store.notice = { text, until: Date.now() + 2600 };
			emit();
			if (noticeTimer) window.clearTimeout(noticeTimer);
			noticeTimer = window.setTimeout(() => { store.notice = null; noticeTimer = 0; emit(); }, 2700);
		}
		function persistState(patch) {
			try {
				fetch(API + "/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ tier: store.tier, permission: store.permission, model: store.modelSel, sessionId: store.viewSessionId || null, turns: store.turns, historyMode: store.historyMode, fullOn: store.fullOn }, patch || {})) }).catch(() => {});
			} catch (e) { /* best effort */ }
		}
		function setTier(id, why) {
			store.tier = id;
			store.armed = id !== "off";
			if (why !== "init") store.tierBySession[sessionKey()] = id; // 只改本会话
			if (why !== "init") store.touched = true;
			beacon("tier-change", { tier: id, armed: store.armed, why: why || "ui" });
			if (why !== "init") persistState();
			emit();
		}
		function setPermission(id, why) {
			if (store.tier === "off") return;
			store.permission = id;
			if (why !== "init") store.permissionBySession[sessionKey()] = id;
			if (why !== "init") store.touched = true;
			beacon("permission-change", { permission: id, why: why || "ui" });
			if (why !== "init") persistState();
			emit();
		}
		/* ══════════ 档位/权限：按会话独立（v55） ══════════
		   每个会话各记一份；没设过的会话继承"上次用的值"（即全局默认）。
		   切换会话时像弹窗一样换入换出 —— 在 A 改档位不会影响 B。 */
		function sessionKey() { return store.viewSessionId || "__none__"; }
		function rememberTierPermission() {
			const k = sessionKey();
			store.tierBySession[k] = store.tier;
			store.permissionBySession[k] = store.permission;
		}
		function applyTierPermissionFor(sid) {
			const k = sid || "__none__";
			const t = store.tierBySession[k];
			const p = store.permissionBySession[k];
			if (typeof t === "string") { store.tier = t; store.armed = t !== "off"; }
			if (typeof p === "string") store.permission = p;
		}

		/* ══════════ 会话隔离：弹窗属于触发它的那个会话 ══════════
		   迷你窗/运行/审查编辑都挂在"当前查看的会话"上；切换会话时把这一份暂存起来，
		   切回来再取回 —— 于是 A 里触发的弹窗不会跑到 B，切回 A 又原样出现。 */
		const VIEW_KEYS = ["run", "overlay", "reviewText", "regenAsk", "regenDir", "rollbackConfirm"];
		function emptyView() {
			return {
				run: null,
				overlay: { open: false, text: "", fullText: "", src: "", sessionId: null },
				reviewText: null, regenAsk: false, regenDir: "", rollbackConfirm: false,
			};
		}
		function stashCurrentView() {
			const sid = store.viewSessionId || "__none__";
			const snap = {};
			for (const k of VIEW_KEYS) snap[k] = store[k];
			store.stash[sid] = snap;
		}
		function restoreViewFor(sid) {
			const key = sid || "__none__";
			const snap = store.stash[key];
			if (snap) { for (const k of VIEW_KEYS) store[k] = snap[k]; return true; }
			const blank = emptyView();
			for (const k of VIEW_KEYS) store[k] = blank[k];
			return false;
		}
		/** composer 报告"当前会话"变化时调用（slot 的 sessionId 是权威来源）。 */
		function onViewSessionChange(next) {
			const sid = next || null;
			if (sid === store.viewSessionId) return;
			const prev = store.viewSessionId;
			rememberTierPermission();      // 把旧会话的档位/权限存进它自己
			stashCurrentView();
			store.viewSessionId = sid;
			applyTierPermissionFor(sid);   // 载入新会话的（没设过则继承当前默认）
			const restored = restoreViewFor(sid);
			beacon("view-session-change", {
				from: prev, to: sid, restored,
				carried: restored && store.run ? store.run.status : null,
				tier: store.tier, permission: store.permission, tierScope: Object.keys(store.tierBySession).length,
				pendingSessions: Object.keys(store.stash).filter((k) => {
					const s = store.stash[k];
					return s && ((s.run && s.run.status !== "aborted") || (s.overlay && s.overlay.open));
				}).length,
			});
			// 切回时若该会话的优化已完成且是自动档，这时才补发（只有当前会话有 composer 可提交）
			const run = store.run;
			if (restored && run && run.readyToSend && store.permission === "auto") {
				const text = String(run.readyToSend);
				run.readyToSend = null;
				window.setTimeout(() => {
					try {
						if (store.latest.actions && store.latest.sessionId === sid) {
							store.latest.actions.setDraft(text);
							store.latest.actions.submit();
							store.overlay.open = false;
							store.run = null;
							store.reviewText = null;
							showNotice("已按 " + run.tier + " 档优化结果发送");
							emit();
						}
					} catch (e) { /* noop */ }
				}, 320);
			}
			emit();
		}

		function emit() { for (const fn of [...store.listeners]) { try { fn() } catch (e) { /* noop */ } } }
		function setOverlay(patch) { store.overlay = Object.assign({}, store.overlay, patch); emit(); }
		function record(kind, text, extra) {
			const row = Object.assign({ t: Date.now(), kind, text: String(text || "").slice(0, 160) }, extra || {});
			store.intercepts.push(row);
			emit();
			return row;
		}
		function draftFromHook() {
			const s = store.latest.input;
			return s && typeof s.draft === "string" ? s.draft : "";
		}
		/* 拦截判定必须读"此刻编辑器里真实存在的字"：React 快照可能滞后于用户输入 */
		function draftFromDom() {
			const ed = editorOf(cardOf(store.node));
			if (!ed) return null;
			const raw = typeof ed.innerText === "string" && ed.innerText.length > 0 ? ed.innerText : (ed.textContent || "");
			return raw.replace(/\u00a0/g, " ");
		}
		function draftLive() {
			const dom = draftFromDom();
			return dom === null ? draftFromHook() : dom;
		}
		function sessionOf() { return store.latest.session || {}; }
		function runningNow() { return sessionOf().running === true; }

		/* ══════════ DOM 定位（全部从本插件节点结构推导，不用产品类名/选择器） ══════════ */
		function cardOf(node) {
			let el = node;
			while (el && el !== document.body) {
				if (el.querySelector && el.querySelector('[contenteditable="true"]')) return el;
				el = el.parentElement;
			}
			return null;
		}
		function editorOf(card) { return card ? card.querySelector('[contenteditable="true"]') : null; }
		function buttonsOf(card) { return card ? Array.from(card.querySelectorAll("button")) : []; }
		function lastButtonOf(card) { const list = buttonsOf(card); return list.length ? list[list.length - 1] : null; }
		/* 发送按钮定位：①本地化标签命中（首选）②兜底=卡片内最后一个 button（官方主按钮的结构位置） */
		function sendButtonOf(card) {
			if (!card) return null;
			for (const b of buttonsOf(card)) {
				const label = b.getAttribute("aria-label");
				if (label && SEND_LABELS.has(label)) return b;
			}
			return lastButtonOf(card);
		}
		function isSendLabel(label) { return Boolean(label && SEND_LABELS.has(label)); }

		/* 发送按钮本地化标签集：懒解析 + locale 变化时重取（产品字典晚于本插件注册时不再失配） */
		const SEND_LABELS = new Set();
		const STOP_LABELS = new Set();
		let localeService = null;
		function loadSendLabels() {
			SEND_LABELS.clear();
			STOP_LABELS.clear();
			try {
				const t = localeService ? localeService.bind("conversation") : null;
				if (t) {
					for (const key of ["input.send", "input.send.queue", "input.send.steer"]) {
						const v = t(key);
						if (typeof v === "string" && v && v !== key) SEND_LABELS.add(v);
					}
					const stop = t("input.stop");
					if (typeof stop === "string" && stop && stop !== "input.stop") STOP_LABELS.add(stop);
				}
			} catch (e) { /* 字典不可用 → 点击路径走结构兜底 */ }
			return [...SEND_LABELS];
		}
		function ensureLabels() { if (SEND_LABELS.size === 0) loadSendLabels(); return SEND_LABELS.size > 0; }

		/* 焦点追踪仅作遥测；判定一律以"此刻 activeElement 是否在输入卡片内"为准 */
		let lastFocusInComposer = false;
		let lastKeyBeacon = 0;
		function insideComposer() {
			const card = cardOf(store.node);
			if (!card) return false;
			const active = document.activeElement;
			if (!active || !card.contains(active)) return false;      // 设置页/重命名框/空白处：一律放行
			if (active.closest && active.closest("button")) return false; // 焦点在按钮上（模型座位等）：Enter 交还官方
			if (active.closest && active.closest('[data-dpo="dock"],[data-dpo="overlay"]')) return false; // 拦截卡内的输入（重跑方向等）：Enter 交还卡片
			return true;
		}

		function beacon(stage, data) {			try {
				fetch(API + "/beacon", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(Object.assign({ t: Date.now(), stage }, data || {})),
				}).catch(() => {});
			} catch (e) { /* best effort */ }
		}

		/* ══════════ 拦截判定（唯一真源，探针与真实手势共用） ══════════ */
		function interceptKey(e) {
			if (!store.armed) return false;
			if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
			if (e.isComposing === true || e.keyCode === 229) return false;
			if (!cardOf(store.node)) return false;
			if (!insideComposer()) return false;
			const trimmed = draftLive().trim();
			if (!trimmed || trimmed.startsWith("/")) return false;
			return true;
		}
		/** 点击接管的唯一判定（探针可直接对任意按钮求值，无需真的派发事件）。 */
		function wouldInterceptClick(btn) {
			if (!store.armed || !btn) return false;
			// 浮层自身的按钮永不吞（回退/×/确认提交/重新生成…）
			if (btn.closest && btn.closest('[data-dpo="dock"],[data-dpo="overlay"]')) return false;
			const card = cardOf(store.node);
			if (!card || !card.contains(btn)) return false;
			// 只有"要发出去的草稿"才接管：空草稿时主按钮是"停止生成"，绝不可吞
			if (!draftLive().trim()) return false;
			const label = btn.getAttribute("aria-label");
			if (label && STOP_LABELS.has(label)) return false;
			ensureLabels();
			return isSendLabel(label) || lastButtonOf(card) === btn;
		}
		function interceptClick(e) {
			const target = e.target;
			const btn = target && target.closest ? target.closest("button") : null;
			return wouldInterceptClick(btn);
		}

		/* ══════════ 会话头部：合并后的唯一入口 ══════════
		   从前它散在输入框左侧（档位滑块 + 权限滑块 + 模型胶囊 + ? 按钮）；
		   现在合并成「模式选择」旁边的一枚胶囊，点开是一个纵行排列的官方菜单。 */
		const TIER_HINT = {
			off: "不拦截，按原生方式发送",
			basic: "把话说清楚，不加新要求",
			advanced: "补上显然需要的约束与验收",
			extreme: "读项目结构，给分阶段行动计划",
		};
		const PERMISSION_HINT = {
			review: "产出可编辑，确认后才发送",
			auto: "优化完成即自动发送",
		};
		const TIER_PREFIX = "tier:";
		const PERM_PREFIX = "perm:";
		const MODEL_PREFIX = "model:";
		const MODEL_DEFAULT_ID = "model:__default__";
		/* 模型菜单里 provider 折叠行的 id 前缀（点它 = 展开/收起，不是选中）。 */
		const PROVIDER_PREFIX = "prov:";
		/* 上下文（上游 0.1.9 功能）：宿主侧的 HISTORY_TURNS_MAX 也是 10，两边要一致。 */
		const TURNS_MAX = 10;
		const HELP_ACTION_ID = "action:help";
		/* 菜单里进入收藏夹的那一项。 */
		const FAV_ACTION_ID = "action:favorites";

		/** 菜单的一行：左边名称、右边灰色说明（纵行排列，一行一个选项）。 */
		function menuRow(name, hint) {
			return h("span", { className: "dpo-row" },
				h("span", { className: "dpo-row-name" }, name),
				hint ? h("span", { className: "dpo-row-hint" }, hint) : null,
			);
		}

		/**
		* 上下文控件：一行之内同时给出「最近 N 回合」和「全文」两件事。
		* 它被塞进一个 type:"label" 的菜单项里 —— label 渲染成 <div> 而不是 <button>，
		* 所以在里面拖动/点击不会触发"选中这一项"。
		* 语义与宿主一致：historyMode="turns" 看 turns（0~10）；"full" + fullOn=true 读全文。
		*/
		function ContextSlider() {
			const trackRef = React.useRef(null);
			const draggingRef = React.useRef(false);
			const full = store.historyMode === "full" && store.fullOn === true;
			const value = Math.max(0, Math.min(TURNS_MAX, Number(store.turns) || 0));
			const pct = full ? 100 : (value / TURNS_MAX) * 100;

			const apply = (turns, commit) => {
				if (store.historyMode !== "turns" || store.turns !== turns || store.fullOn === true) {
					store.historyMode = "turns";
					store.fullOn = false;
					store.turns = turns;
					store.touched = true;
					emit();
				}
				if (commit) persistState();
			};
			const pick = (clientX, commit) => {
				const el = trackRef.current;
				if (!el) return;
				const r = el.getBoundingClientRect();
				const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
				apply(Math.round(t * TURNS_MAX), commit);
			};
			const onDown = (e) => {
				draggingRef.current = true;
				try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针无捕获 */ }
				pick(e.clientX, false);
				e.preventDefault();
			};
			const onUp = (e) => {
				if (!draggingRef.current) return;
				draggingRef.current = false;
				try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
				pick(e.clientX, true);
			};
			return h("div", { className: "dpo-ctx", "data-dpo": "context-row", "data-full": String(full) },
				h("span", { className: "dpo-ctx-label" }, "上下文"),
				h("div", {
					ref: trackRef, className: "dpo-ctx-track", "data-dpo": "ctx-track",
					role: "slider", tabIndex: 0,
					"aria-label": "优化时读入最近多少回合（0~10）",
					"aria-valuemin": 0, "aria-valuemax": TURNS_MAX, "aria-valuenow": full ? TURNS_MAX : value,
					title: "拖动选择读入最近几回合；最左＝不读取",
					onPointerDown: onDown, onPointerMove: (e) => { if (draggingRef.current) pick(e.clientX, false); },
					onPointerUp: onUp, onPointerCancel: onUp,
					onKeyDown: (e) => {
						const cur = store.historyMode === "turns" ? value : TURNS_MAX;
						if (e.key === "ArrowLeft" || e.key === "ArrowDown") { apply(Math.max(0, cur - (e.shiftKey ? 5 : 1)), true); e.preventDefault(); }
						else if (e.key === "ArrowRight" || e.key === "ArrowUp") { apply(Math.min(TURNS_MAX, cur + (e.shiftKey ? 5 : 1)), true); e.preventDefault(); }
						else if (e.key === "Home") { apply(0, true); e.preventDefault(); }
						else if (e.key === "End") { apply(TURNS_MAX, true); e.preventDefault(); }
					},
				},
					h("div", { className: "dpo-ctx-fill", style: { width: pct + "%" } }),
					h("div", { className: "dpo-ctx-thumb", style: { left: pct + "%" } }),
				),
				h("span", { className: "dpo-ctx-value", "data-dpo": "ctx-value" }, full ? "全文" : (value ? value + " 回合" : "不读取")),
				h("button", {
					type: "button", className: "dpo-ctx-full", "data-dpo": "ctx-full", "data-on": String(full),
					title: full ? "改回按回合读取" : "改用完整上下文（与工作 AI 看到的一致）",
					onClick: (e) => {
						e.preventDefault(); e.stopPropagation();
						if (full) { store.historyMode = "turns"; store.fullOn = false; }
						else { store.historyMode = "full"; store.fullOn = true; store.turns = TURNS_MAX; }
						store.touched = true;
						persistState(); emit();
					},
				}, "全文"),
			);
		}

		/** 纵行菜单：档位 / 权限 / 上下文 / 模型（子菜单）/ 帮助，一行一项、自上而下。 */
		function chipMenuItems() {
			const items = [];
			items.push({ type: "label", id: "lbl-tier", text: "提示词优化" });
			for (const t of TIERS) items.push({ id: TIER_PREFIX + t.id, label: menuRow(t.label, TIER_HINT[t.id] || "") });
			items.push({ type: "separator", id: "sep-perm" });
			items.push({ type: "label", id: "lbl-perm", text: "优化权限" });
			const off = store.tier === "off";
			for (const p of PERMISSIONS) items.push({ id: PERM_PREFIX + p.id, label: menuRow(p.label, PERMISSION_HINT[p.id] || ""), disabled: off });
			items.push({ type: "separator", id: "sep-model" });
			items.push({ type: "label", id: "lbl-model", text: "优化模型（与对话模型独立）" });
			items.push({ id: MODEL_DEFAULT_ID, label: menuRow("会话默认", "跟随当前会话的模型") });
			const cat = store.modelCatalog;
			const groups = cat && Array.isArray(cat.groups) ? cat.groups : [];
			if (groups.length === 0) {
				const text = store.modelCatalogLoading === true ? "正在加载模型目录…"
					: (store.modelCatalogError ? "加载失败：" + store.modelCatalogError : "（暂无可用模型）");
				items.push({ id: MODEL_PREFIX + "__none__", label: menuRow(text, ""), disabled: true });
			}
			/* 每家 provider 收成一行，模型放进它的**子菜单**（悬停或聚焦时向右飞出）——
			   主菜单因此只保留「会话默认 + 各提供商」，不再被模型名拉长。
			   官方子菜单项不画 ✓，所以"当前选中的那个"用右侧说明标出来。 */
			for (const g of groups) {
				const models = g.models || [];
				const holdsSel = Boolean(store.modelSel && store.modelSel.provider === g.id);
				if (models.length === 0) {
					items.push({ id: PROVIDER_PREFIX + g.id, label: menuRow(g.name, "无可用模型" + (g.degraded ? " · 不可达" : "")), disabled: true });
					continue;
				}
				const hint = holdsSel
					? "当前 · " + (store.modelSel.name || store.modelSel.model)
					: (models.length + " 个模型" + (g.degraded ? " · 不可达" : ""));
				items.push({
					id: PROVIDER_PREFIX + g.id,
					icon: h(UI.IconChevronRightOutline14, { size: 14 }),
					label: menuRow(g.name, hint),
					submenu: models.map((m) => {
						const cur = cat && cat.current && cat.current.provider === g.id && cat.current.model === m.id;
						const sel = Boolean(store.modelSel && store.modelSel.provider === g.id && store.modelSel.model === m.id);
						return {
							id: MODEL_PREFIX + g.id + "/" + m.id,
							label: menuRow(m.name, sel ? "已选" : (cur ? "会话当前" : "")),
						};
					}),
				});
			}
			items.push({ type: "separator", id: "sep-ctx" });
			/* 上下文收成一行：label 类型的项渲染成 <div> 而不是 <button>，
			   所以里面的滑块不会和"点一下＝选中这一项"打架。 */
			items.push({ type: "label", id: "lbl-ctx-row", text: h(ContextSlider, null) });
			items.push({ type: "separator", id: "sep-fav" });
			const favCount = Array.isArray(store.favorites) ? store.favorites.length : null;
			items.push({
				id: FAV_ACTION_ID,
				label: menuRow("提示词收藏夹", favCount === null ? "把好用的产出存起来" : (favCount > 0 ? favCount + " 条" : "还是空的")),
			});
			items.push({ type: "separator", id: "sep-help" });
			items.push({ id: HELP_ACTION_ID, label: menuRow("使用帮助", "怎么用 / 档位 / 权限 / 推荐组合") });
			return items;
		}

		/** 当前各项设置的选中项（菜单同时显示多个 ✓）。 */
		function chipSelectedIds() {
			const ids = [
				TIER_PREFIX + store.tier,
				PERM_PREFIX + store.permission,
				store.modelSel ? MODEL_PREFIX + store.modelSel.provider + "/" + store.modelSel.model : MODEL_DEFAULT_ID,
			];
			// 上下文不再用 ✓（它是一行滑块，值直接显示在滑块右边）
			return ids;
		}

		/** 菜单点选：档位/权限/模型就地生效并保持菜单打开（一口气调完三项）；帮助则换面板。 */
		function onChipSelect(id) {
			if (typeof id !== "string") return;
			if (id.indexOf(TIER_PREFIX) === 0) { setTier(id.slice(TIER_PREFIX.length)); return; }
			if (id.indexOf(PERM_PREFIX) === 0) { setPermission(id.slice(PERM_PREFIX.length)); return; }
			if (id === MODEL_DEFAULT_ID) {
				store.modelSel = null;
				persistState({ tier: store.tier, permission: store.permission, model: null });
				emit();
				return;
			}
			if (id.indexOf(MODEL_PREFIX) === 0) {
				const rest = id.slice(MODEL_PREFIX.length);
				const cut = rest.indexOf("/");
				if (cut <= 0) return;
				const provider = rest.slice(0, cut);
				const model = rest.slice(cut + 1);
				let name = model;
				const groups = (store.modelCatalog && store.modelCatalog.groups) || [];
				for (const g of groups) {
					if (g.id !== provider) continue;
					for (const m of (g.models || [])) if (m.id === model) name = m.name;
				}
				store.modelSel = { provider: provider, model: model, name: name };
				persistState();
				emit();
				return;
			}
			if (id === FAV_ACTION_ID) { openFavorites("menu"); return; }
			if (id === HELP_ACTION_ID) {
				store.menuOpen = false;
				store.helpOpen = true;
				emit();
			}
		}

		/** 模型目录：真加载 + 缓存 + 状态（曾经只在探针里拉过一次，弹层永远停在"加载中"）。 */
		function loadCatalog(reason, force) {
			const now = Date.now();
			if (!force && store.modelCatalog && store.modelCatalogAt && (now - store.modelCatalogAt) < CATALOG_TTL_MS) return Promise.resolve(store.modelCatalog);
			if (store.modelCatalogLoading === true) return store.modelCatalogPromise || Promise.resolve(store.modelCatalog);
			store.modelCatalogLoading = true;
			store.modelCatalogError = null;
			emit();
			const t0 = Date.now();
			const url = API + "/models" + (force ? "?force=1" : "");
			store.modelCatalogPromise = fetch(url, { cache: "no-store" })
				.then((r) => r.json())
				.then((d) => {
					const groups = d && Array.isArray(d.groups) ? d.groups : [];
					store.modelCatalog = { current: (d && d.current) || null, groups };
					store.modelCatalogAt = Date.now();
					store.modelCatalogLoading = false;
					store.modelCatalogError = groups.length === 0 ? "目录为空" : null;
					beacon("catalog-loaded", {
						reason: reason || "ui", groups: groups.length,
						models: groups.reduce((n, g) => n + ((g.models || []).length), 0),
						ms: Date.now() - t0, cached: d && d.cached === true, hostBuiltMs: d && d.builtMs,
						degraded: d && d.degraded ? d.degraded : null,
					});
					emit();
					return store.modelCatalog;
				})
				.catch((e) => {
					store.modelCatalogLoading = false;
					store.modelCatalogError = String(e && e.message ? e.message : e);
					beacon("catalog-error", { reason: reason || "ui", error: store.modelCatalogError.slice(0, 200), ms: Date.now() - t0 });
					emit();
					return null;
				});
			return store.modelCatalogPromise;
		}

		/* ══════════ 提示词收藏夹 ══════════
		   宿主把它落盘在 ~/.dsh/prompt-optimizer-favorites.json（独立文件，全部本机读写）。
		   这里只负责拉取 / 增删改 / 导入导出，界面在下面的 favoritesPanel。 */
		function loadFavorites(reason, force) {
			if (store.favLoading === true) return;
			if (!force && Array.isArray(store.favorites)) return;
			store.favLoading = true;
			store.favError = null;
			emit();
			fetch(API + "/favorites", { cache: "no-store" })
				.then((r) => r.json())
				.then((d) => {
					store.favLoading = false;
					if (d && d.ok) store.favorites = Array.isArray(d.items) ? d.items : [];
					else store.favError = "读取失败";
					emit();
				})
				.catch((e) => {
					store.favLoading = false;
					store.favError = String((e && e.message) || e);
					emit();
				});
		}
		/** 所有写操作都走这里：宿主回传完整列表，客户端直接替换，不做本地乐观更新（避免两边不一致）。 */
		function favoritesPost(patch) {
			store.favBusy = true;
			emit();
			return fetch(API + "/favorites", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
			}).then((r) => r.json()).then((d) => {
				store.favBusy = false;
				if (d && d.ok) { if (Array.isArray(d.items)) store.favorites = d.items; }
				else showNotice("收藏操作失败" + (d && d.error ? "：" + d.error : ""));
				emit();
				return d;
			}).catch((e) => {
				store.favBusy = false;
				showNotice("收藏操作失败：" + String((e && e.message) || e));
				emit();
				return null;
			});
		}
		/** 收藏一段文本（卡片上的产出、对话里某条消息，都走这里）。 */
		function favoriteAdd(text, source, tier) {
			const body = String(text || "").trim();
			if (!body) { showNotice("没有可收藏的内容"); return Promise.resolve(null); }
			beacon("favorite-add", { chars: body.length, source: source || "optimized" });
			return favoritesPost({ action: "add", text: body, tier: tier || store.tier, source: source || "optimized" }).then((d) => {
				if (d && d.ok) showNotice(d.deduped ? "这条已经在收藏夹里了" : "已收藏（共 " + (store.favorites || []).length + " 条）");
				return d;
			});
		}
		/** 把卡片里当前的产出（含手动编辑过的版本）存进收藏夹。 */
		function favoriteCurrentOutput() {
			const run = store.run;
			const text = (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : (run ? run.text : "");
			favoriteAdd(text, "optimized", run ? run.tier : store.tier);
		}
		/** 把一条收藏填进输入框 —— 只填不发，按不按回车由你决定。 */
		function applyFavorite(item) {
			const text = item && item.text ? String(item.text) : "";
			if (!text) return;
			if (!store.latest.actions || typeof store.latest.actions.setDraft !== "function") { showNotice("当前没有可用的输入框"); return; }
			try { store.latest.actions.setDraft(text); } catch (e) { showNotice("填入输入框失败"); return; }
			beacon("favorite-apply", { chars: text.length, id: item.id });
			showNotice("已填入输入框（不会自动发送）");
			emit();
		}
		/** 打开收藏夹：不再开对话框，而是展开右侧栏并切到收藏夹 tab。 */
		function openFavorites(from) {
			store.menuOpen = false;
			store.helpOpen = false;
			store.favConfirm = null;
			store.favEditId = null;
			beacon("favorites-open", { from: from || "menu" });
			loadFavorites("open", true);
			if (!sidebarRight) { showNotice("右侧栏还没就绪，稍后再试"); return; }
			try {
				sidebarRight.openTab(FAV_KIND, {});
			} catch (e) {
				beacon("favorites-tab-failed", { error: String((e && e.message) || e) });
				showNotice("打开收藏夹失败：" + String((e && e.message) || e));
				return;
			}
			expandRightbar();
			emit();
		}
		function closeFavorites() {
			// 侧栏 tab 有自己的关闭按钮，这里只清临时态
			store.favConfirm = null;
			store.favEditId = null;
			emit();
		}
		/** 导出成 JSON 文件（浏览器下载）。 */
		function exportFavorites() {
			const items = Array.isArray(store.favorites) ? store.favorites : [];
			if (items.length === 0) { showNotice("收藏夹是空的"); return; }
			try {
				const payload = JSON.stringify({ version: 1, plugin: NS, exportedAt: new Date().toISOString(), items: items }, null, 2);
				const blob = new Blob([payload], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = "prompt-optimizer-favorites-" + new Date().toISOString().slice(0, 10) + ".json";
				document.body.appendChild(a);
				a.click();
				a.remove();
				window.setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* noop */ } }, 5000);
				beacon("favorites-export", { count: items.length });
				showNotice("已导出 " + items.length + " 条");
			} catch (e) { showNotice("导出失败：" + String((e && e.message) || e)); }
		}
		/** 从 JSON 文件导入（按 id 与正文去重，只增不改）。 */
		function importFavoritesFile(file, inputEl) {
			if (inputEl) inputEl.value = "";
			if (!file) return;
			const reader = new FileReader();
			reader.onload = () => {
				let items = null;
				try {
					const parsed = JSON.parse(String(reader.result || ""));
					items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
				} catch (e) { items = null; }
				if (!items) { showNotice("这个文件不是收藏夹的导出格式"); return; }
				beacon("favorites-import", { count: items.length });
				favoritesPost({ action: "import", items: items }).then((d) => {
					if (d && d.ok) showNotice("导入完成：新增 " + (d.added || 0) + " 条，跳过 " + (d.skipped || 0) + " 条");
				});
			};
			reader.onerror = () => showNotice("读取文件失败");
			reader.readAsText(file);
		}

		/* ══════════ 对话里每条用户消息的「收藏」按钮（DOM 注入） ══════════
		   官方只给助手消息那排动作留了插槽（conversation.chat.assistant-actions）；
		   用户消息那排（时钟 + 复制）是 UserMessageNodeView 里硬编码渲染的，没有槽可挂。
		   所以这里直接往那一排里插一枚按钮：
		   - 认「含复制按钮、且时钟在左（timeStart）」的那排 —— 实测只有用户消息是这种形态，
		     助手消息那排多一个类、没有 timeStart；
		   - 按钮的 class 直接抄复制按钮的，所以样式、尺寸、hover 全部与它一致；
		   - 插进去的节点在 React 之外，重渲染时可能被清掉 → 有自愈：定时扫描补回来。 */
		const MSGFAV_FLAG = "data-dpo-msgfav";

		/** 复制按钮的 aria-label 随界面语言变（Copy / 复制），两种都认。 */
		function isCopyButton(btn) {
			return /^(copy|复制|拷貝|拷贝)$/i.test(String(btn.getAttribute("aria-label") || "").trim());
		}

		/** 一条用户消息的正文＝「用户行里去掉那排动作剩下的部分」。 */
		function userTextOf(actionRow) {
			const owner = actionRow.parentElement;
			if (!owner) return "";
			let text = "";
			for (const child of Array.from(owner.children)) {
				if (child === actionRow || child.contains(actionRow)) continue;
				text += String(child.innerText || "") + "\n";
			}
			return text.trim();
		}

		const MSGFAV_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4.4 2.6h7.2c.66 0 1.2.54 1.2 1.2v9.46l-4.8-2.87-4.8 2.87V3.8c0-.66.54-1.2 1.2-1.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

		/** 扫一遍对话，把缺的收藏按钮补上。幂等：已经插过的行会跳过。 */
		function ensureMsgFavButtons() {
			if (document.hidden === true) return 0;
			let added = 0;
			let rows = null;
			try { rows = document.querySelectorAll('div[class*="_actions"]'); } catch (e) { return 0; }
			for (const row of rows) {
				if (!(row instanceof HTMLElement)) continue;
				if (row.querySelector("[" + MSGFAV_FLAG + "]")) continue;      // 已经插过
				const buttons = Array.from(row.querySelectorAll("button"));
				const copy = buttons.find(isCopyButton);
				if (!copy) continue;                                            // 不是消息动作行
				if (!row.querySelector('span[class*="_timeStart"]')) continue;   // 时钟不在左 → 不是用户消息
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = copy.className;   // 抄复制按钮的类，样式完全一致
				btn.setAttribute(MSGFAV_FLAG, "1");
				btn.setAttribute("data-dpo", "msg-fav");
				btn.setAttribute("aria-label", "收藏这条提示词");
				btn.title = "收藏这条提示词到收藏夹";
				btn.innerHTML = MSGFAV_SVG;
				btn.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					const body = userTextOf(row);
					if (!body) { showNotice("没取到这条消息的正文"); return; }
					favoriteAdd(body, "conversation");
				});
				copy.insertAdjacentElement("afterend", btn);
				added += 1;
			}
			return added;
		}

		/** 使用帮助：与菜单同源的扁平面板（portal 到 body，锚定在胶囊上方）。
		    左上角有一枚小返回键 —— 回到上一层（设置菜单），而不是直接关掉整个流程。 */
		function helpPanel(extra) {
			const line = (k, v) => h("div", { className: "dpo-help-row" }, h("span", { className: "dpo-help-k" }, k), h("span", { className: "dpo-help-v" }, v));
			return h("div", Object.assign({
				className: "dpo-help-panel", "data-dpo": "help-panel", role: "dialog",
			}, extra || {}),
				h("div", { className: "dpo-help-bar" },
					h("button", {
						type: "button", className: "dpo-back", "data-dpo": "help-back",
						title: "返回设置菜单",
						onClick: () => { store.helpOpen = false; store.menuOpen = true; emit(); },
					},
						h(UI.IconChevronLeftOutline14, { size: 14 }),
						h("span", null, "返回"),
					),
					h("span", { className: "dpo-help-head" }, "使用帮助"),
				),
				h("div", { className: "dpo-help-sec" }, "怎么用"),
				line("①", "照常输入，按 Enter（或点发送）"),
				line("②", "消息不会直接发出，先被优化"),
				line("③", "卡片里看「产出」，可直接编辑再决定发送"),
				line("④", "「思考」「已查证」默认折叠，点标题展开"),
				h("div", { className: "dpo-help-sec" }, "档位（自上而下由弱到强）"),
				line("普通", "只把话说清楚，不加新需求（约 3 秒）"),
				line("高级", "补上显然需要的约束与验收（约 20 秒）"),
				line("极端", "读项目真实结构 → 分阶段行动计划 + 预案（约 20 秒）"),
				line("关闭", "完全不拦截，恢复原生发送"),
				h("div", { className: "dpo-help-sec" }, "权限"),
				line("需要审查", "产出可编辑，点「确认提交」才发送"),
				line("自动输出", "优化一完成就自动发出（失败也会按原文发出）"),
				h("div", { className: "dpo-help-sec" }, "拦截卡按钮"),
				line("确认提交", "把产出（可先编辑）交给工作 AI 发出去"),
				line("重新生成", "先给个方向，再按该方向重跑一版"),
				line("放行原文", "不优化了，按你的原文直接发出"),
				line("‹ 回退", "停止优化、收起卡片、不发消息，原文留在输入框"),
				h("div", { className: "dpo-help-tip", "data-dpo": "help-tip" }, "想要发挥插件所有能力且自动化，建议【极端】+【自动】。"),
				h("div", { className: "dpo-help-meta", "data-dpo": "help-meta" }, "作者：啃轮胎的西狐 · 版本 0.1.1beta1 · 版本日期 2026/09/11"),
			);
		}

		/**
		* 提示词收藏夹面板：与帮助面板同一个外壳（portal 到 body、锚定胶囊上方）。
		* 列出 + 搜索 + 逐条（填入 / 置顶 / 改名 / 删除）+ 底部（导入 / 导出 / 清空）。
		* 「填入」只写进输入框草稿、不发送 —— 按不按回车由你决定。
		*/
		function favoritesBody() {
			const all = Array.isArray(store.favorites) ? store.favorites : [];
			const q = String(store.favQuery || "").trim().toLowerCase();
			const matched = q
				? all.filter((x) => (String(x.title || "") + " " + String(x.text || "")).toLowerCase().indexOf(q) >= 0)
				: all;
			// 置顶优先，其余按时间倒序
			const shown = matched.slice().sort((a, b) =>
				(b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0) || ((b.createdAt || 0) - (a.createdAt || 0)));
			const p2 = (n) => (n < 10 ? "0" + n : String(n));
			const fmtTime = (ms) => {
				try {
					const d = new Date(Number(ms) || Date.now());
					return (d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
				} catch (e) { return ""; }
			};
			const rows = shown.map((it) => {
				const confirming = Boolean(store.favConfirm && store.favConfirm.kind === "one" && store.favConfirm.id === it.id);
				/* 编辑态：标题 + 正文一起改。正文是主角，所以给它一个多行框。 */
				if (store.favEditId === it.id) {
					const cancel = () => { store.favEditId = null; emit(); };
					const commit = () => {
						const body = String(store.favEditBody || "").trim();
						if (!body) { showNotice("正文不能为空"); return; }
						favoritesPost({ action: "update", id: it.id, title: store.favEditText, text: body }).then(() => { store.favEditId = null; emit(); });
					};
					return h("div", { key: it.id, className: "dpo-fav-edit", "data-dpo": "fav-edit", "data-id": it.id },
						h("input", {
							className: "dpo-fav-input", "data-dpo": "fav-edit-title", type: "text",
							placeholder: "标题（留空则自动取正文首行）", value: store.favEditText || "", spellCheck: false,
							onChange: (e) => { store.favEditText = e.target.value; emit(); },
							onKeyDown: (e) => {
								e.stopPropagation();
								if (e.key === "Enter") { e.preventDefault(); commit(); }
								else if (e.key === "Escape") { e.preventDefault(); cancel(); }
							},
						}),
						h("textarea", {
							className: "dpo-fav-textarea", "data-dpo": "fav-edit-text", rows: 5,
							placeholder: "正文", value: store.favEditBody || "", spellCheck: false,
							onChange: (e) => { store.favEditBody = e.target.value; emit(); },
							onKeyDown: (e) => {
								e.stopPropagation();
								if (e.key === "Escape") { e.preventDefault(); cancel(); }
								// 正文要能换行，所以保存用 Ctrl/Cmd+Enter
								else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
							},
						}),
						h("div", { className: "dpo-fav-editacts" },
							h("span", { className: "dpo-fav-hint" }, "Ctrl+Enter 保存 · Esc 取消"),
							h("button", { type: "button", className: "dpo-fav-btn", "data-dpo": "fav-edit-save", onClick: commit }, "保存"),
							h("button", { type: "button", className: "dpo-fav-btn", "data-dpo": "fav-edit-cancel", onClick: cancel }, "取消"),
						),
					);
				}
				return h("div", { key: it.id, className: "dpo-fav-row", "data-dpo": "fav-row", "data-id": it.id, "data-pinned": String(it.pinned === true) },
					h("button", {
						type: "button", className: "dpo-fav-body", "data-dpo": "fav-apply",
						title: "填入输入框（不会自动发送）",
						onClick: () => applyFavorite(it),
					},
						h("span", { className: "dpo-fav-title" }, it.title || "（无标题）"),
						h("span", { className: "dpo-fav-meta" },
							(it.pinned === true ? "已置顶 · " : "") + tierLabelOf(it.tier || store.tier) + " · " + String(it.text || "").length + " 字 · " + fmtTime(it.createdAt)),
					),
					confirming
						? h("div", { className: "dpo-fav-acts" },
							h("button", { type: "button", className: "dpo-fav-btn danger", "data-dpo": "fav-del-yes", onClick: () => favoritesPost({ action: "remove", id: it.id }).then(() => { store.favConfirm = null; emit(); }) }, "删除"),
							h("button", { type: "button", className: "dpo-fav-btn", "data-dpo": "fav-del-no", onClick: () => { store.favConfirm = null; emit(); } }, "取消"))
						: h("div", { className: "dpo-fav-acts" },
							h("button", {
								type: "button", className: "dpo-fav-btn", "data-dpo": "fav-pin", "data-on": String(it.pinned === true),
								title: it.pinned === true ? "取消置顶" : "置顶到最前",
								onClick: () => favoritesPost({ action: "update", id: it.id, pinned: it.pinned !== true }),
							}, it.pinned === true ? "已置顶" : "置顶"),
							h("button", {
								type: "button", className: "dpo-fav-btn", "data-dpo": "fav-rename", title: "编辑标题与正文",
								onClick: () => {
									store.favEditId = it.id;
									store.favEditText = it.title || "";
									store.favEditBody = it.text || "";
									store.favConfirm = null;
									emit();
								},
							}, "编辑"),
							h("button", { type: "button", className: "dpo-fav-btn danger", "data-dpo": "fav-del", title: "删除这一条", onClick: () => { store.favConfirm = { kind: "one", id: it.id }; emit(); } }, "删除")),
				);
			});
			const clearing = Boolean(store.favConfirm && store.favConfirm.kind === "all");
			/* 只返回"内容"，外壳交给宿主：现在它作为右侧栏的一个 tab 出现，
			   tab 有自己的标题栏与关闭按钮，不需要遮罩和对话框外壳。 */
			return h(React.Fragment, null,
				h("input", {
					className: "dpo-fav-search", "data-dpo": "fav-search", type: "search",
					placeholder: "搜索标题或内容…", value: store.favQuery || "", spellCheck: false,
					onChange: (e) => { store.favQuery = e.target.value; emit(); },
					onKeyDown: (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); store.favQuery = ""; emit(); } },
				}),
				store.favLoading === true && all.length === 0 ? h("div", { className: "dpo-fav-empty" }, "正在读取…") : null,
				store.favError ? h("div", { className: "dpo-fav-empty", "data-dpo": "fav-error" }, "读取失败：" + store.favError) : null,
				all.length === 0 && store.favLoading !== true && !store.favError
					? h("div", { className: "dpo-fav-empty", "data-dpo": "fav-empty" },
						"还没有收藏。",
						h("div", { className: "dpo-hint-quiet" }, "在拦截卡上点「收藏本条」，就会存到这里。"))
					: null,
				all.length > 0 && shown.length === 0
					? h("div", { className: "dpo-fav-empty", "data-dpo": "fav-nomatch" }, "没有匹配「" + store.favQuery + "」的条目")
					: null,
				rows.length > 0 ? h("div", { className: "dpo-fav-list", "data-dpo": "fav-list" }, ...rows) : null,
				h("div", { className: "dpo-fav-foot", "data-dpo": "fav-foot" },
					clearing
						? h(React.Fragment, null,
							h("span", { className: "dpo-fav-confirmtext" }, "清空全部 " + all.length + " 条？不可撤销。"),
							h("button", { type: "button", className: "dpo-btn danger", "data-dpo": "fav-clear-yes", onClick: () => favoritesPost({ action: "clear" }).then(() => { store.favConfirm = null; emit(); }) }, "确定清空"),
							h("button", { type: "button", className: "dpo-btn", "data-dpo": "fav-clear-no", onClick: () => { store.favConfirm = null; emit(); } }, "取消"))
						: h(React.Fragment, null,
							h("button", { type: "button", className: "dpo-fav-btn", "data-dpo": "fav-import", disabled: store.favBusy === true, onClick: () => { const el = document.querySelector('[data-dpo="fav-file"]'); if (el) el.click(); } }, "导入"),
							h("button", { type: "button", className: "dpo-fav-btn", "data-dpo": "fav-export", disabled: all.length === 0, onClick: exportFavorites }, "导出"),
							h("button", { type: "button", className: "dpo-fav-btn danger", "data-dpo": "fav-clear", disabled: all.length === 0 || store.favBusy === true, onClick: () => { store.favConfirm = { kind: "all" }; emit(); } }, "清空全部")),
				),
				h("input", {
					type: "file", accept: ".json,application/json", "data-dpo": "fav-file", className: "dpo-fav-file",
					onChange: (e) => importFavoritesFile(e.target.files && e.target.files[0], e.target),
				}),
			);
		}

		/** 收藏夹的侧栏面板：一行工具栏（条数）+ 上面那份内容。 */
		function FavoritesPane() {
			const [, force] = React.useState(0);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			const all = Array.isArray(store.favorites) ? store.favorites : [];
			return h("div", { className: "dpo-pane dpo-fav-pane", "data-dpo": "fav-pane" },
				h("div", { className: "dpo-fav-bar" },
					h("span", { className: "dpo-fav-head" }, "提示词收藏夹"),
					h("span", { className: "dpo-fav-count", "data-dpo": "fav-count" }, all.length + " 条"),
				),
				favoritesBody(),
			);
		}

		/** 收藏夹 tab 的标题：名字 + 条数。 */
		function FavoritesPaneTitle() {
			const [, force] = React.useState(0);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			const n = Array.isArray(store.favorites) ? store.favorites.length : 0;
			return h("span", { className: "dpo-pane-title" }, "提示词收藏夹" + (n > 0 ? " · " + n : ""));
		}

		/**
		* 拦截设置的唯一入口：一枚胶囊 + 它弹出的纵行菜单。
		* 固定挂在输入框底部工具栏那一行（conversation.input.left），会话里和新对话页完全一致。
		* 因为在屏幕底部，菜单向上弹、并用 compact 保证整张菜单落在胶囊上方而不是盖住它。
		*/
		const HELP_GAP = 6;    /* 面板与胶囊之间留的空隙 */
		const HELP_MARGIN = 12; /* 面板与视口边缘留的空隙（要和 useAnchoredPosition 的 margin 一致） */
		function OptimizeChip() {
			const anchorRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const [, force] = React.useState(0);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			const open = store.menuOpen === true;
			const helpOpen = store.helpOpen === true;
			/* 官方 Menu 只在「打开 / 滚动 / 窗口 resize」这三个时机重算自己的位置，
			   内容变高（展开某家 provider、目录刚加载完）它不会跟着重算 ——
			   菜单会一路往下长到视口外，最下面那几个模型就点不到了，
			   它自带的 max-height + 内滚也因为这个错位而失效。
			   这里在内容高度可能变化的时刻补发一次 resize，让它重新夹紧：
			   超过视口高度时会自动收在 100vh-24px 并出现内部滚动条。 */
			const menuKey = open
				? ((store.modelCatalog && store.modelCatalog.groups) || []).reduce((n, g) => n + ((g.models || []).length), 0)
				: "";
			React.useEffect(() => {
				if (!menuKey) return undefined;
				const id = window.setTimeout(() => {
					try { window.dispatchEvent(new Event("resize")); } catch (e) { /* noop */ }
				}, 0);
				return () => window.clearTimeout(id);
			}, [menuKey]);
			/* 帮助面板贴在胶囊上方，所以它的高度上限必须由"胶囊上方还剩多少"决定，
			   不能只按视口高度给（70vh 常常比上方空间大 → 被夹到顶部反过来压住胶囊）。
			   这里量出可用高度喂给面板，useAnchoredPosition 内部的 ResizeObserver 会跟着重算位置。 */
			const [panelMax, setPanelMax] = React.useState(520);
			React.useLayoutEffect(() => {
				if (!helpOpen) return undefined;
				const measure = () => {
					const el = anchorRef.current;
					if (!el) return;
					const top = el.getBoundingClientRect().top;
					setPanelMax(Math.max(180, Math.round(top - HELP_GAP - HELP_MARGIN)));
				};
				measure();
				window.addEventListener("resize", measure);
				window.addEventListener("scroll", measure, true);
				return () => {
					window.removeEventListener("resize", measure);
					window.removeEventListener("scroll", measure, true);
				};
			}, [helpOpen]);
			const helpPos = UI.useAnchoredPosition({ open: helpOpen, anchorRef: anchorRef, panelRef: panelRef, side: "top", gap: HELP_GAP, margin: HELP_MARGIN });
			UI.useDismissOnOutsidePointer(anchorRef, helpOpen, () => { if (store.helpOpen) { store.helpOpen = false; emit(); } }, panelRef);
			/* 收藏夹搬进右侧栏后，这里不再需要 Esc 关闭对话框（tab 有自己的关闭按钮）。 */
			// 打开菜单时才去拉模型目录（懒加载，不在每次渲染里打网络）
			React.useEffect(() => {
				if (open && !store.modelCatalog && store.modelCatalogLoading !== true) loadCatalog("chip-open", false);
			}, [open]);
			if (!isActiveInstance()) return null;
			const off = store.tier === "off";
			const tierLabel = (TIERS.find((x) => x.id === store.tier) || {}).label || "";
			const permLabel = (PERMISSIONS.find((x) => x.id === store.permission) || {}).label || "";
			const modelName = store.modelSel ? store.modelSel.name : store.modelLabel;
			return h(React.Fragment, null,
				h(UI.Menu, {
					open: open,
					onClose: () => { if (store.menuOpen) { store.menuOpen = false; emit(); } },
					items: chipMenuItems(),
					selectedIds: chipSelectedIds(),
					onSelect: onChipSelect,
					side: "top",
					align: "start",
					portal: true,
					/* 官方子菜单是"从父项向右飞出"且不做视口夹取 —— 窄窗口下会飞出右边、点不到。
					   这里在窗口不够宽时把整张菜单左移一点点，给飞出的子菜单留位置：
					   需要 chipLeft + 主菜单宽 + 间隙 + 子菜单宽 能放下，放不下就按缺口左移，
					   但绝不移出左边距。宽度用的是保守估计值（主菜单 250 / 子菜单 170）。 */
					getAnchorRect: () => {
						const el = anchorRef.current;
						if (!el) return null;
						const r = el.getBoundingClientRect();
						const need = 250 + 10 + 220; // 主菜单宽 + 间隙 + 子菜单宽（实测子菜单最宽约 200）
						const overflow = (r.left + need) - (window.innerWidth - 12);
						const shift = overflow > 0 ? Math.min(overflow, Math.max(0, r.left - 12)) : 0;
						return { left: r.left - shift, right: r.right - shift, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
					},
					// 胶囊在屏幕底部、菜单往上弹：compact 让整张菜单能完全落在胶囊上方，
					// 否则它会被视口夹到顶部、反过来盖住触发它的胶囊和输入框。
					compact: true,
					anchor: h("button", {
						ref: anchorRef,
						type: "button",
						className: "dpo-chip",
						"data-dpo": "chip",
						"data-off": String(off),
						"aria-haspopup": "menu",
						"aria-expanded": open,
						title: "提示词优化：" + tierLabel + " · " + permLabel + " · " + modelName,
						onClick: () => {
							store.menuOpen = !store.menuOpen;
							if (store.menuOpen) store.helpOpen = false;
							emit();
						},
					},
						h(UI.IconSparkle16, { size: 14, className: "dpo-chip-icon" }),
						h("span", { className: "dpo-chip-label" }, "优化 " + tierLabel),
						h(UI.IconChevronDownOutline14, { className: "dpo-chip-chevron" }),
					),
				}),
				/* 帮助面板必须"先渲染、后定位"：useAnchoredPosition 要量到面板高度才能算出
				   "贴在胶囊上方"的 top；如果等 helpPos 才渲染，首次量到的高度是 0，
				   算出来的 top 就等于胶囊顶部，面板再往下铺 → 直接跑出屏幕。
				   官方 Menu 基元用的也是这一招（先 visibility:hidden 挂在 0,0，量到再显示）。 */
				helpOpen
					? ReactDOM.createPortal(helpPanel({
						ref: panelRef,
						style: {
							left: (helpPos ? helpPos.left : 0) + "px",
							top: (helpPos ? helpPos.top : 0) + "px",
							maxHeight: panelMax + "px",
							visibility: helpPos ? "visible" : "hidden",
						},
					}), document.body)
					: null,
				/* 收藏夹现在也是右侧栏的一个 tab，这里不再需要 portal。 */
			);
		}

		/** 输入框槽位：胶囊本体 + 接住官方输入面（草稿 + 发送动作）+ 一个零占位锚点。 */
		function ComposerCapture(props) {
			const nodeRef = React.useRef(null);
			const input = props.useInput((s) => s);
			const session = props.useSession((s) => s);
			store.latest.input = input;
			store.latest.session = session;
			store.latest.actions = props.inputActions;
			store.latest.sessionId = props.sessionId;
			React.useEffect(() => {
				store.node = nodeRef.current;
				return () => { if (store.node === nodeRef.current) store.node = null; };
			}, []);
			React.useEffect(() => { onViewSessionChange(props.sessionId || null); }, [props.sessionId]);
			const [, force] = React.useState(0);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			if (!isActiveInstance()) return null;
			// 隐形锚点：拦截判定要从 DOM 反推"输入卡片"（cardOf）—— 必须留在输入框里。
			// 提示条同理留在原地（它是即时反馈，不是设置项）。
			return h(React.Fragment, null,
				h("span", { ref: nodeRef, className: "dpo-anchor", "data-dpo": "anchor", "aria-hidden": "true" }),
				h(OptimizeChip, null),
				store.notice && Date.now() < store.notice.until
					? h("span", { className: "dpo-notice", "data-dpo": "notice" }, store.notice.text)
					: null,
			);
		}
		/** 查证动作的明细行（极端档才会用只读工具查项目结构）。折叠外壳交给 dockFold。 */
		function traceList() {
			const t = store.trace;
			const rows = t ? [...(t.normal || []).map((x) => ({ ...x, phase: "查证" })), ...(t.capped || []).map((x) => ({ ...x, phase: "收尾" }))] : [];
			return h("div", { className: "dpo-trace", "data-dpo": "trace" },
				...rows.slice(0, 8).map((r, i) => h("div", { key: i, className: "dpo-trace-row", "data-dpo": "trace-row" },
					h("span", { className: "dpo-trace-tool" }, r.tool),
					h("span", { className: "dpo-trace-args" }, JSON.stringify(r.args || {}).slice(0, 46)),
					h("span", { className: "dpo-trace-meta" }, String(r.ms) + "ms · " + String(r.resultLines) + "行"),
				)),
			);
		}

		/* ══════════ 实时优化运行（SSE 双通道 → 拦截卡分区渲染） ══════════ */
		/** 确定回退：停止后端运行 + 收起卡片 + 不发消息；输入框原文保持不动。 */
		function rollbackYes() {
			const run = store.run;
			const original = run ? String(run.request || "") : "";
			store.rollbackConfirm = false;
			// 回退承诺"不发送任何消息"：先打终态标记，迟到的 done 才不会又发一条
			if (run) run.settled = "rolled-back";
			if (run && run.es) { try { run.es.close() } catch (e) { /* noop */ } }
			if (run && run.runId) {
				fetch(API + "/run/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: run.runId }) }).catch(() => {});
			}
			store.run = null;
			store.reviewText = null;
			store.regenAsk = false;
			setOverlay({ open: false });
			// 原文还原：拦截发生在发送之前，草稿通常仍在；若被清空则显式写回
			try {
				if (original && store.latest.actions && original !== draftLive()) store.latest.actions.setDraft(original);
			} catch (e) { /* noop */ }
			beacon("rollback-done", { restored: original.slice(0, 40), draft: String(draftLive() || "").slice(0, 40) });
			showNotice("已回退：优化已停止，输入框原文保留");
			emit();
		}

		/** 拦截卡几何自检：卡片"该在却不在"时留下可判定的证据。 */
		function beaconOverlayGeom(stage) {
			try {
				const el = document.querySelector('[data-dpo="dock"]');
				if (!el) { beacon("overlay-geom", { stage, exists: false, open: store.overlay.open === true }); return; }
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				beacon("overlay-geom", {
					stage, exists: true,
					rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					viewport: { w: window.innerWidth, h: window.innerHeight },
					inView: r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
					display: cs.display, visibility: cs.visibility, opacity: cs.opacity, overflow: cs.overflow,
					expanded: el.getAttribute("data-open") === "true",
					scrollH: el.scrollHeight, clientH: el.clientHeight,
				});
			} catch (e) { beacon("overlay-geom", { stage, error: String(e) }); }
		}

		/** 接线：拦截到"发送"后真正启动优化（档位/权限决定后续自动提交或转审查态）。 */
		function interceptAndOptimize(text) {
			const body = String(text || "").trim();
			if (!body) return;
			// 已有 run 在跑：绝不静默起第二个（否则第一个被覆盖，用户会感觉"发出去了但没反应"）
			const busy = store.run && (store.run.status === "connecting" || store.run.status === "running");
			const awaitingReview = store.run && store.run.status === "done" && store.permission === "review";
			if (busy || awaitingReview) {
				beacon("dup-intercept", { status: store.run.status, chars: body.length, kind: busy ? "busy" : "awaiting-review" });
				showNotice(busy ? "优化进行中…请稍候（或点「回退」按原文处理）" : "审查中：请点「确认提交」／「重新生成」／「回退」");
				setOverlay({ open: true, src: busy ? "dup" : "review" });
				return;
			}
			const tier = store.tier === "off" ? "basic" : store.tier;
			record("optimize-start", body, { tier, permission: store.permission, sessionId: store.viewSessionId });
			setOverlay({ open: true, text: body.slice(0, 80), fullText: body, src: "optimize", sessionId: store.viewSessionId });
			startRun(body, tier, false);
		}

		function startRun(request, tier, forceError, opts) {
			const extra = opts || {};
			const sid = store.viewSessionId || null;
			if (store.run && store.run.es) { try { store.run.es.close() } catch (e) { /* noop */ } }
			const run = {
				status: "connecting", reasoning: "", text: "", error: null,
				startedAt: Date.now(), firstPaintMs: null, request, tier,
				forceError: forceError === true, runId: null, es: null,
				direction: extra.direction || null, version: (extra.version || 1),
				sessionId: sid, readyToSend: null,
				/* settled：本次运行是否已被用户终结（放行 / 回退 / 已自动发送）。
				   宿主在 done 之前会先推一条 history，这里也存着。 */
				settled: null, history: null,
			};
			store.run = run;
			store.reviewText = null;
			dockReset();
			setOverlay({ open: true, text: String(request || "").slice(0, 80), fullText: String(request || ""), src: "run", sessionId: sid });
			emit();
			// 拦截发生 → 自动展开右侧栏并切到优化面板（结果直接可见，不用去找）
			openOptimizeTab();
			/** 自动档要把结果发出去：只有"该会话正在被查看"时才有 composer 可提交，否则挂起等切回。 */
			const autoSend = (text, noticeText) => {
				const isView = (run.sessionId || null) === (store.viewSessionId || null);
				const out = String(text || "");
				if (!out) return false;
				/* 用户已经放行 / 回退过这一轮 → 绝不再自动发送（上游 0.1.9 修的缺陷：
				   闭包里那份 run 还活着，done 事件会照发第二条，表现为"排队发送"）。 */
				if (run.settled) {
					beacon("auto-send-suppressed", { why: run.settled, chars: out.length, view: isView, tier: run.tier });
					return false;
				}
				if (isView && store.latest.actions) {
					run.settled = "auto-sent"; // 幂等：同一次运行只自动发送一次
					store.overlay.open = false;
					store.run = null;
					store.reviewText = null;
					dockReset();
					store.latest.actions.setDraft(out);
					store.latest.actions.submit();
					if (noticeText) showNotice(noticeText);
					emit();
					return true;
				}
				run.readyToSend = out;
				beacon("auto-send-deferred", { sessionId: run.sessionId, view: store.viewSessionId, chars: out.length });
				showNotice("另一会话的优化已完成，切回该会话即自动发送");
				return false;
			};
			fetch(API + "/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ request, tier, turns: store.turns, historyMode: store.historyMode, fullOn: store.fullOn, sessionId: sid || store.latest.sessionId, forceError: forceError === true, provider: store.modelSel ? store.modelSel.provider : null, model: store.modelSel ? store.modelSel.model : null, direction: extra.direction || null, prevText: extra.prevText || null }),
			}).then((r) => r.json()).then((d) => {
				if (!d || d.ok !== true) { run.status = "error"; run.error = "启动失败：" + JSON.stringify(d); emit(); return; }
				run.runId = d.runId;
				const es = new EventSource(API + "/stream?runId=" + encodeURIComponent(d.runId));
				run.es = es;
				es.onmessage = (ev) => {
					let msg = null;
					try { msg = JSON.parse(ev.data) } catch (e) { return; }
					const cur = run; // 绑定本 run 自身：即使被切到别的会话（暂存）也继续收流
					if (msg.type === "snapshot") {
						cur.reasoning = msg.reasoning || "";
						cur.text = msg.text || "";
						if (msg.usage) cur.usage = msg.usage;
						if (msg.status && msg.status !== "running") cur.status = msg.status;
						if (msg.error) cur.error = msg.error;
						if (msg.history) cur.history = msg.history;
						if (cur.firstPaintMs === null && (cur.reasoning || cur.text)) cur.firstPaintMs = Date.now() - cur.startedAt;
					} else if (msg.type === "history") {
						/* 宿主在开跑前先推一条 history：这次究竟读入了多少上下文。 */
						cur.history = msg.history || null;
					} else if (msg.type === "reasoning-delta" || msg.type === "text-delta") {
						if (msg.type === "reasoning-delta") cur.reasoning += msg.text; else cur.text += msg.text;
						if (cur.firstPaintMs === null) cur.firstPaintMs = Date.now() - cur.startedAt;
						cur.status = "running";
					} else if (msg.type === "usage") {
						let u = null;
						try {
							u = typeof msg.usage === "string" ? JSON.parse(msg.usage)
								: (msg.usage || (typeof msg.text === "string" ? JSON.parse(msg.text) : null));
						} catch (e) { u = null; }
						if (u && typeof u === "object") {
							cur.usage = u;
							if (cur.usageBeaconed !== true) {
								cur.usageBeaconed = true;
								beacon("usage-delta", { keys: Object.keys(u).slice(0, 10), reasoning: reasoningTokensOf(u), total: u.totalTokens || u.total_tokens || null, tier: cur.tier });
							}
						}
					} else if (msg.type === "aborted") {
						cur.status = "aborted";
					} else if (msg.type === "error") {
						cur.status = "error";
						cur.error = msg.message || "未知错误";
						// 死模型自愈：provider 不接 / 连不上 → 清掉落盘的模型选择，下次回默认
						const deadRoute = /NO_ADAPTER|TRANSPORT|no adapter registered|Connection error|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(String(cur.error || ""));
						if (deadRoute) {
							store.modelSel = null;
							persistState({ tier: store.tier, permission: store.permission, model: null });
							beacon("model-selfheal", { reason: String(cur.error || "").slice(0, 120) });
						}
						// 自动档：优化失败也要把用户的消息发出去（fail-open），绝不静默吞掉
						if (store.permission === "auto") {
							const original = String(cur.request || "");
							autoSend(original, deadRoute ? "优化模型不可用 → 已按原文发出，并回退到默认模型" : "优化失败 → 已按原文发出");
							beacon("fail-open-send", { kind: "error", deadRoute, originalChars: original.length, reason: String(cur.error || "").slice(0, 120) });
						}
					} else if (msg.type === "done") {
						cur.status = "done";
						if (cur.settled) {
							// 用户已放行 / 回退：只记状态，不再开卡片、不再自动发送
							beacon("done-after-settle", { why: cur.settled, chars: String(cur.text || "").length, tier: cur.tier });
						} else if (store.permission === "auto" && String(cur.text || "").trim()) {
							autoSend(String(cur.text), "已按 " + cur.tier + " 档优化结果发送");
						} else if (store.permission === "auto") {
							// 空产出也放行原文：宁可按原文发出，也不要"按了发送却什么都没发生"
							const original = String(cur.request || "");
							autoSend(original, "优化未产出内容 → 已按原文发出");
							beacon("fail-open-send", { kind: "empty-done", originalChars: original.length });
						} else {
							// 审查态：确保浮层处于打开状态，双按钮在粘底操作区内
							cur.regenAsk = false;
							if ((cur.sessionId || null) === (store.viewSessionId || null) || cur.sessionId === null) setOverlay({ open: true, src: "review", sessionId: cur.sessionId });
							beacon("review-ready", { chars: String(cur.text || "").length, tier: cur.tier, permission: store.permission, sessionId: cur.sessionId, isView: (cur.sessionId || null) === (store.viewSessionId || null) });
							window.setTimeout(() => { beaconOverlayGeom("review-ready"); }, 80);
							try {
								window.setTimeout(() => {
									const el = document.querySelector('[data-dpo="review"]');
									if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
								}, 60);
							} catch (e) { /* noop */ }
						}
					}
					if (cur.status !== "running" && cur.status !== "connecting" && cur.es) { try { cur.es.close() } catch (e) { /* noop */ } cur.es = null; }
					emit();
				};
				es.onerror = () => { /* 连接中断：保留已收内容，状态由事件决定 */ };
			}).catch((e) => {
				run.status = "error"; run.error = String(e); emit();
			});
		}

		function humanizeError(raw) {
			const s = String(raw || "");
			if (s.includes("NO_ADAPTER")) return "该模型供应商未注册（没有可用适配器）——请在优化模型里换一个可用的 provider";
			if (s.includes("ABORTED")) return "请求已被取消（回退或超时）";
			if (s.includes("no-llm-route")) return "找不到可用的模型路由（请先选一个优化模型）";
			if (/401|unauthor/i.test(s)) return "凭据无效或未授权（请检查该 provider 的 API Key）";
			if (/429|rate.?limit/i.test(s)) return "请求过于频繁，请稍后重试";
			if (/timeout|ETIMEDOUT/i.test(s)) return "请求超时，可重试";
			return s.length > 160 ? s.slice(0, 160) + "…" : s;
		}

		/** token 数格式化：1234 → 1.2k；缺失则返回 null（有些 provider 不上报用量）。 */
		function fmtTokens(n) {
			const v = Number(n);
			if (!Number.isFinite(v) || v <= 0) return null;
			return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : String(Math.round(v));
		}
		/** 从 usage 里挑"思考消耗"：优先 reasoningTokens，其次 completion 里的 reasoning 明细。 */
		function reasoningTokensOf(usage) {
			if (!usage || typeof usage !== "object") return null;
			const direct = usage.reasoningTokens || usage.reasoning_tokens || (usage.details && (usage.details.reasoningTokens || usage.details.reasoning_tokens));
			if (Number.isFinite(Number(direct))) return Number(direct);
			return null;
		}
		function usageChips(usage) {
			if (!usage || typeof usage !== "object") return null;
			const rt = fmtTokens(reasoningTokensOf(usage));
			const out = fmtTokens(usage.outputTokens || usage.completionTokens || usage.output_tokens);
			const tot = fmtTokens(usage.totalTokens || usage.total_tokens);
			return { reasoning: rt, output: out, total: tot };
		}

		/** 运行中让面板跟随滚动（用户手动上滚时不抢），流式产出看起来是"活"的。 */
		function liveScroll(el) {
			if (!el) return;
			const st = store.run && store.run.status;
			if (st !== "running" && st !== "connecting") return;
			if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) el.scrollTop = el.scrollHeight;
		}
		/* ── 拦截卡的三个部件（形态取自官方 TodoPanel 折叠卡 + 审批卡动作条） ── */

		/** 卡片展开态：null＝按状态自动（审查态默认展开让人看清要发什么），否则听用户的。 */
		function dockExpanded() {
			if (store.dockOpen !== null) return store.dockOpen === true;
			const run = store.run;
			return Boolean(run && run.status === "done" && store.permission === "review");
		}
		function dockState() {
			const run = store.run;
			if (!run) return "idle";
			if (run.status === "connecting" || run.status === "running") return "running";
			if (run.status === "done") return "done";
			if (run.status === "error") return "error";
			return "idle";
		}
		function tierLabelOf(id) { return (TIERS.find((x) => x.id === id) || {}).label || id; }
		function permLabelOf(id) { return (PERMISSIONS.find((x) => x.id === id) || {}).label || id; }

		/** 头部：一行讲清"在干什么" —— 状态点 + 标题 + 状态词 + token；整行就是折叠开关。 */
		function dockHeader() {
			const run = store.run;
			const live = Boolean(run && (run.status === "running" || run.status === "connecting"));
			const chips = run ? usageChips(run.usage) : null;
			const st = dockState();
			const word = st === "running" ? "优化中…" : st === "done" ? (store.permission === "review" ? "待确认" : "已完成") : st === "error" ? "失败" : "已拦截";
			const expanded = dockExpanded();
			return h("button", {
				type: "button", className: "dpo-dock-head", "data-dpo": "dock-head",
				"aria-expanded": expanded,
				title: expanded ? "收起" : "展开查看",
				onClick: () => { store.dockOpen = !expanded; emit(); },
			},
				h("span", { className: "dpo-dock-lead" }, h(UI.IconSparkle16, { size: 16 })),
				h("span", { className: "dpo-dock-title" }, "提示词优化"),
				h("span", { className: "dpo-dock-word", "data-state": st }, word),
				/* 这次究竟读入了多少上下文（上游 0.1.9 的能力）：只统计你的原话，
				   工作 AI 的回复内容不会进入上下文，所以字数只按用户文本累计。 */
				run && run.history && run.history.userTurns > 0
					? h("span", {
						className: "dpo-tok-chip dpo-tok-muted", "data-dpo": "history-chip",
						title: run.history.mode === "full"
							? "本次读入的是完整上下文（与工作 AI 看到的一致）"
							: "本次读入的对话上下文（只含你的原话全文；工作 AI 的回复只保留长度与工具次数）",
					}, "上下文 " + (run.history.userTurns || 0) + " 回合 · " + (run.history.chars || 0) + " 字")
					: null,
				chips && chips.total ? h("span", { className: "dpo-tok-chip", title: "本次优化总 token" }, "Σ " + chips.total + " tok") : null,
				live && !chips ? h("span", { className: "dpo-tok-chip dpo-tok-live", title: "等待 provider 上报用量" }, "tok …") : null,
				h("span", { className: "dpo-dock-chevron" }, expanded ? h(UI.IconChevronUpOutline14, { size: 14 }) : h(UI.IconChevronDownOutline14, { size: 14 })),
			);
		}

		/** 折叠区（思考 / 查证动作）：默认就一行，点了才展开 —— 不再有常驻空占位。 */
		function dockFold(kind, title, meta, body) {
			const open = kind === "think" ? store.thinkOpen === true : store.traceOpen === true;
			return h("div", { className: "dpo-fold", "data-dpo": "fold-" + kind, "data-open": String(open) },
				h("button", {
					type: "button", className: "dpo-fold-head", "aria-expanded": open,
					onClick: () => { if (kind === "think") store.thinkOpen = !open; else store.traceOpen = !open; emit(); },
				},
					h("span", { className: "dpo-fold-title" }, title),
					meta ? h("span", { className: "dpo-fold-meta" }, meta) : null,
					h("span", { className: "dpo-fold-chevron" }, open ? h(UI.IconChevronUpOutline14, { size: 14 }) : h(UI.IconChevronDownOutline14, { size: 14 })),
				),
				open ? body : null,
			);
		}

		/** 卡片正文：回退确认 → 错误 → 产出（主角）→ 思考 → 查证动作 → 一行安静的档位说明。 */
		function dockBody(outRef) {
			const run = store.run;
			const live = Boolean(run && (run.status === "running" || run.status === "connecting"));
			const done = Boolean(run && run.status === "done");
			const chips = run ? usageChips(run.usage) : null;
			const editable = done && store.permission === "review";
			const text = (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : (run ? run.text : "");
			const parts = [];
			if (store.rollbackConfirm === true) parts.push(h("div", { className: "dpo-dock-banner", "data-dpo": "rollback-confirm" },
				h("span", { className: "dpo-dock-banner-text" }, "回退将停止优化、保留输入框原文，不发送任何消息。"),
				h("button", { type: "button", className: "dpo-btn danger", "data-dpo": "rollback-yes", onClick: () => { beacon("rollback-yes", {}); rollbackYes(); } }, "确定回退"),
				h("button", { type: "button", className: "dpo-btn", "data-dpo": "rollback-no", onClick: () => { store.rollbackConfirm = false; emit(); } }, "取消"),
			));
			if (run && run.status === "error") parts.push(h("div", { className: "dpo-dock-error", "data-dpo": "run-error" },
				h("span", { className: "dpo-dock-error-icon" }, h(UI.IconWarningOutline16, { size: 16 })),
				h("div", { className: "dpo-dock-error-text" },
					h("div", { title: String(run.error || "") }, humanizeError(run.error)),
					store.modelSel
						? h("button", {
							type: "button", className: "dpo-dock-link", "data-dpo": "reset-model",
							onClick: () => { store.modelSel = null; persistState({ tier: store.tier, permission: store.permission, model: null }); startRun(run.request, run.tier, false); },
						}, "改用默认模型重试")
						: null,
				),
			));
			if (store.regenAsk === true) parts.push(h("div", { className: "dpo-regen-ask", "data-dpo": "regen-ask" },
				h("div", { className: "dpo-dock-label" }, "重新生成：给个方向（可留空＝换一次随机重跑）"),
				h("input", {
					className: "dpo-regen-input", "data-dpo": "regen-input", type: "text",
					placeholder: "例如：更短、保留技术细节、强调验收标准…",
					value: store.regenDir || "",
					onChange: (e) => { store.regenDir = e.target.value; emit(); },
					onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submitRegen(); } },
				}),
			));
			if (editable) {
				parts.push(h("div", { className: "dpo-dock-label", "data-dpo": "review-hint" }, "产出 · 将原样发给工作 AI（可直接编辑） · " + String(text || "").length + " 字"));
				parts.push(h("textarea", {
					ref: outRef, className: "dpo-out", "data-dpo": "review-text",
					value: text, spellCheck: false,
					onChange: (e) => { store.reviewText = e.target.value; emit(); },
				}));
			} else if (live && String(run.text || "")) {
				parts.push(h("div", { className: "dpo-dock-label" }, "产出 · 生成中"));
				parts.push(h("div", { className: "dpo-out dpo-out-live", ref: liveScroll, "data-dpo": "out-live" }, run.text));
			}
			if (run && (live || run.reasoning)) {
				const meta = chips && chips.reasoning ? chips.reasoning + " tok" : (run.reasoning ? run.reasoning.length + " 字" : "—");
				parts.push(dockFold("think", live ? "思考中…" : "思考", meta,
					h("div", { className: "dpo-fold-body", ref: liveScroll }, run.reasoning || "（等待思考…）")));
			}
			const trace = store.trace;
			const traceCount = trace ? ((trace.normal || []).length + (trace.capped || []).length) : 0;
			if (traceCount > 0) parts.push(dockFold("trace", "已查证 " + traceCount + " 步", "只读", traceList()));
			parts.push(h("div", { className: "dpo-dock-meta" }, "档位 " + tierLabelOf(store.tier) + " · 权限 " + permLabelOf(store.permission)));
			return h("div", { className: "dpo-dock-body" }, ...parts);
		}

		/** 动作栏：四个按钮的**位置和数量在任何状态下都不变**，只切可用性。
		    错误态的"重试"就是这里的"重新生成"；"改用默认模型重试"是错误块里的文字链接。 */
		function dockFooter() {
			const run = store.run;
			const live = Boolean(run && (run.status === "running" || run.status === "connecting"));
			const done = Boolean(run && run.status === "done");
			const regenMode = store.regenAsk === true;
			const canConfirm = Boolean(done && store.permission === "review");
			const canRegen = Boolean(run) && !live;
			// 有产出才谈得上收藏（运行中流式内容也算，存的是"此刻看到的这一版"）
			const curText = (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : (run ? run.text : "");
			const canFav = String(curText || "").trim().length > 0;
			return h("div", { className: "dpo-dock-foot", "data-dpo": "dock-foot" },
				h("div", { className: "dpo-dock-foot-side" },
					regenMode
						? h("button", { type: "button", className: "dpo-btn", "data-dpo": "regen-cancel", onClick: () => { store.regenAsk = false; emit(); } }, "取消重跑")
						: h("button", { type: "button", className: "dpo-btn", "data-dpo": "rollback", onClick: () => { beacon("rollback-click", {}); store.rollbackConfirm = true; emit(); } }, "‹ 回退"),
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "release", onClick: releaseOriginal }, "放行原文"),
					h("button", {
						type: "button", className: "dpo-btn", "data-dpo": "favorite",
						disabled: !canFav || store.favBusy === true,
						title: "把当前产出存进提示词收藏夹（含你手动编辑过的版本）",
						onClick: favoriteCurrentOutput,
					}, "收藏本条"),
					// 与「收藏本条」挨着：一个存、一个看，是同一件事的两半
					h("button", {
						type: "button", className: "dpo-btn", "data-dpo": "dock-fav-open",
						title: "打开提示词收藏夹（点一条可填回输入框）",
						onClick: () => openFavorites("dock"),
					}, "收藏夹"),
				),
				h("div", { className: "dpo-dock-foot-side dpo-dock-foot-end" },
					regenMode
						? h("button", { type: "button", className: "dpo-btn primary", "data-dpo": "regen-go", onClick: submitRegen }, "按此方向重跑")
						: h("button", {
							type: "button", className: "dpo-btn", "data-dpo": "regen", disabled: !canRegen,
							onClick: () => {
								beacon("regen-click", { hasRun: Boolean(store.run) });
								store.regenAsk = true;
								store.dockOpen = true;
								if (store.regenDir === undefined) store.regenDir = "";
								emit();
							},
						}, run && run.status === "error" ? "重试" : "重新生成"),
					regenMode ? null : h("button", {
						type: "button", className: "dpo-btn primary", "data-dpo": "confirm",
						disabled: !canConfirm,
						onClick: () => { beacon("confirm-click", {}); confirmSubmit(); },
					}, "确认提交"),
				),
			);
		}

		/** 按用户给的方向重跑（空方向＝直接重跑）。 */
		function submitRegen() {
			const cur = store.run;
			const dir = String(store.regenDir || "").trim();
			beacon("regen-go", { dir: dir.slice(0, 60) });
			store.regenAsk = false;
			if (!cur) return;
			const prev = (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : cur.text;
			startRun(cur.request, cur.tier, false, { direction: dir || null, prevText: prev, version: (cur.version || 1) + 1 });
		}

		/** 确认提交：把（可能已编辑的）文本交回官方发送链路，随后收起卡片。 */
		function confirmSubmit() {
			const run = store.run;
			const text = (store.reviewText !== undefined && store.reviewText !== null)
				? store.reviewText
				: (run ? run.text : "");
			setOverlay({ open: false });
			store.run = null;
			store.reviewText = null;
			dockReset();
			if (text && store.latest.actions) {
				store.latest.actions.setDraft(text);
				store.latest.actions.submit();
			}
			emit();
		}

		/** 放行原文（卡片与降级面板共用）：完整原文优先，绝不截断。 */
		function releaseOriginal() {
			const settling = store.run;
			const text = store.overlay.fullText || (settling && settling.request) || draftLive();
			beacon("release-original", { chars: String(text || "").length, from: store.overlay.fullText ? "fullText" : (settling ? "run.request" : "draft") });
			/* 先打终态标记再清 store.run：SSE 闭包里那份 run 还活着，
			   没有这个标记的话迟到的 done 事件会照样自动发送（上游 0.1.9 修的缺陷）。 */
			if (settling) settling.settled = "released";
			if (settling && settling.es) { try { settling.es.close() } catch (e) { /* noop */ } settling.es = null; }
			if (settling && settling.runId) {
				// 放行就没必要继续烧 token 了，直接让后端停掉
				fetch(API + "/run/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: settling.runId }) }).catch(() => {});
			}
			setOverlay({ open: false });
			store.run = null;
			store.reviewText = null;
			dockReset();
			if (text && store.latest.actions) {
				store.latest.actions.setDraft(text);
				store.latest.actions.submit();
			}
			emit();
		}

		/** 一次运行收尾时复位卡片上的临时开关：展开态回到"按状态自动"，折叠区全部收起。 */
		function dockReset() {
			store.dockOpen = null;
			store.thinkOpen = false;
			store.traceOpen = false;
			store.rollbackConfirm = false;
			store.regenAsk = false;
			store.regenDir = "";
		}

		/** 降级面板：卡片渲染异常时仍给出「回退 / 放行原文」两个出口（绝不"无声消失"）。 */
		function DockFallback(props) {
			return h("div", { className: "dpo-dock", "data-dpo": "dock", "data-degraded": "1", "data-open": "true" },
				h("div", { className: "dpo-dock-head" },
					h("span", { className: "dpo-dock-lead" }, h(UI.IconWarningOutline16, { size: 16 })),
					h("span", { className: "dpo-dock-title" }, "提示词优化"),
					h("span", { className: "dpo-dock-word", "data-state": "error" }, "渲染降级"),
				),
				h("div", { className: "dpo-dock-body" },
					store.rollbackConfirm === true
						? h("div", { className: "dpo-dock-banner", "data-dpo": "rollback-confirm" },
							h("span", { className: "dpo-dock-banner-text" }, "回退将停止优化、保留输入框原文，不发送任何消息。"),
							h("button", { type: "button", className: "dpo-btn danger", "data-dpo": "rollback-yes", onClick: () => { beacon("rollback-yes", {}); rollbackYes(); } }, "确定回退"),
							h("button", { type: "button", className: "dpo-btn", "data-dpo": "rollback-no", onClick: () => { store.rollbackConfirm = false; emit(); } }, "取消"),
						)
						: null,
					h("div", { className: "dpo-dock-error", "data-dpo": "run-error" },
						h("span", { className: "dpo-dock-error-icon" }, h(UI.IconWarningOutline16, { size: 16 })),
						h("div", { className: "dpo-dock-error-text" }, "卡片渲染出错，已降级（优化仍在后台进行）。错误：" + String((props && props.err) || "未知")),
					),
				),
				h("div", { className: "dpo-dock-foot", "data-dpo": "dock-foot" },
					h("div", { className: "dpo-dock-foot-side" },
						h("button", { type: "button", className: "dpo-btn", "data-dpo": "rollback", onClick: () => { store.rollbackConfirm = true; emit(); } }, "‹ 回退"),
					),
					h("div", { className: "dpo-dock-foot-side dpo-dock-foot-end" },
						h("button", { type: "button", className: "dpo-btn primary", "data-dpo": "release", onClick: releaseOriginal }, "放行原文"),
					),
				),
			);
		}

		/** 错误边界：捕获卡片渲染异常 → 留证据 + 渲染降级面板，而不是整块消失。 */
		class DockBoundary extends React.Component {
			constructor(props) { super(props); this.state = { err: null }; }
			static getDerivedStateFromError(error) { return { err: String((error && error.message) || error) }; }
			componentDidCatch(error, info) {
				beacon("overlay-error", {
					message: String((error && error.message) || error),
					stack: String((error && error.stack) || "").slice(0, 700),
					componentStack: String((info && info.componentStack) || "").slice(0, 700),
					runStatus: store.run ? store.run.status : null,
					permission: store.permission, tier: store.tier,
				});
			}
			render() { return this.state.err ? h(DockFallback, { err: this.state.err }) : this.props.children; }
		}
		/** 侧栏面板的宿主：套一层错误边界，面板渲染异常时给出「回退 / 放行原文」两个出口。 */
		const PaneHost = () => h(DockBoundary, null, h(OptimizePane));

		/* ══════════ 右侧栏面板 ══════════
		   拦截与优化的界面搬到 DSH 官方的**右侧栏**里（ctx.sidebarRightTabs 注册 tab 类型 +
		   sidebar.right.pane.tab 提供表体），输入框那一行只留一枚胶囊。
		   为什么用官方 API 而不是别的侧栏插件：bettersidebar v0.19+ 自己也已迁到这个 API，
		   走同一条路，两边的 tab 会并排出现在同一个右侧栏里。
		   实测（1440x900，新对话页与会话里都验过）：hero 上会话面同样是挂载着的，
		   所以"新对话里按回车被拦截"也能自动展开侧栏，不需要额外的降级卡片。 */
		const SIDEBAR_KIND = "prompt-optimizer";
		/** 收藏夹是右侧栏里的第二个 tab（与优化面板并排）。 */
		const FAV_KIND = "prompt-optimizer-favorites";
		/* 注册 tab 类型时拿到的官方控制器与 layout 服务；注册之前是 null。 */
		let sidebarRight = null;
		let layoutService = null;

		/**
		* 把右侧栏展开并切到优化 tab。
		* openTab 内部会 require() 当前绑定的会话面 —— 拿不到就抛错（比如某种布局下右侧栏没挂载），
		* 那种情况下静默放弃：产出仍然在 store 里，用户手动打开右侧栏就能看到。
		*/
		/* 展开右侧栏必须用 layout.openRightbar —— **不能用 controller.toggleExpanded()**：
		   那是个"切换"，而布局状态的更新是异步的，切完立刻再判断会得到"还没展开"，
		   于是又切一次、正好切回收起（实测面板就停在 x=视口宽 的屏幕外）。
		   openRightbar(track, fullscreen) 是直接赋值，重复调用无害。
		   track 是布尔值（官方内部就是 shown && !autoFullscreen），窄窗时按官方的做法转全屏。 */
		function expandRightbar() {
			try {
				if (!layoutService) return;
				const narrow = (window.innerWidth || 0) < 768;
				layoutService.openRightbar(!narrow, narrow);
			} catch (e) { /* 展开失败不算错：用户手动打开右侧栏一样能看到 */ }
		}

		function openOptimizeTab() {
			if (!sidebarRight) return false;
			try {
				sidebarRight.openTab(SIDEBAR_KIND, {});
			} catch (e) {
				beacon("sidebar-open-failed", { error: String((e && e.message) || e), phase: "openTab" });
				return false;
			}
			expandRightbar();
			return true;
		}

		/** 面板顶部：状态点 + 状态词 + 上下文/token —— 取代原来卡片头部那行。 */
		function paneStatus() {
			const run = store.run;
			const live = Boolean(run && (run.status === "running" || run.status === "connecting"));
			const chips = run ? usageChips(run.usage) : null;
			const st = dockState();
			const word = st === "running" ? "优化中…" : st === "done" ? (store.permission === "review" ? "待确认" : "已完成") : st === "error" ? "失败" : "已拦截";
			return h("div", { className: "dpo-pane-status", "data-dpo": "pane-status", "data-state": st },
				h("span", { className: "dpo-dock-lead" }, h(UI.IconSparkle16, { size: 16 })),
				h("span", { className: "dpo-dock-word", "data-state": st }, word),
				run && run.history && run.history.userTurns > 0
					? h("span", {
						className: "dpo-tok-chip dpo-tok-muted", "data-dpo": "history-chip",
						title: run.history.mode === "full"
							? "本次读入的是完整上下文（与工作 AI 看到的一致）"
							: "本次读入的对话上下文（只含你的原话全文；工作 AI 的回复只保留长度与工具次数）",
					}, "上下文 " + (run.history.userTurns || 0) + " 回合 · " + (run.history.chars || 0) + " 字")
					: null,
				chips && chips.total ? h("span", { className: "dpo-tok-chip", title: "本次优化总 token" }, "Σ " + chips.total + " tok") : null,
				live && !chips ? h("span", { className: "dpo-tok-chip dpo-tok-live", title: "等待 provider 上报用量" }, "tok …") : null,
			);
		}

		/** 侧栏里的优化面板：状态行 + 正文区 + 动作栏（后两块与原来完全共用）。 */
		function OptimizePane(props) {
			const [, force] = React.useState(0);
			const outRef = React.useRef(null);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			const o = store.overlay;
			const run = store.run;
			// 产出编辑框自动增高（上限交给 CSS 的 max-height）
			const text = (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : (run ? run.text : "");
			React.useLayoutEffect(() => {
				const el = outRef.current;
				if (!el) return;
				el.style.height = "auto";
				el.style.height = Math.min(el.scrollHeight, Math.round((window.innerHeight || 800) * 0.6)) + "px";
			}, [text, o.open]);
			if (o.open !== true) {
				return h("div", { className: "dpo-pane", "data-dpo": "pane", "data-state": "idle" },
					h("div", { className: "dpo-pane-empty", "data-dpo": "pane-empty" },
						"当前没有正在进行的优化。",
						h("div", { className: "dpo-pane-empty-hint" }, "在输入框里正常输入并按回车，这里会显示优化过程与产出。")));
			}
			return h("div", { className: "dpo-pane", "data-dpo": "pane", "data-state": dockState() },
				paneStatus(),
				dockBody(outRef),
				dockFooter(),
			);
		}

		/** tab 标题：一枚状态点 + 名字。侧栏的 tab 条会用它。 */
		function OptimizePaneTitle() {
			const [, force] = React.useState(0);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			const st = store.overlay.open === true ? dockState() : "idle";
			return h("span", { className: "dpo-pane-title", "data-state": st }, "提示词优化");
		}

		/* ══════════ 探针：合成手势 → 观察 → 报告 ══════════ */
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

		function dispatchKey(target, init, tag) {
			const cfg = Object.assign({ key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true }, init || {});
			const ev = new KeyboardEvent("keydown", cfg);
			ev.__dpoTag = tag || "dpo";
			try { Object.defineProperty(ev, "keyCode", { get: () => (cfg.isComposing ? 229 : 13) }); } catch (e) { /* noop */ }
			target.dispatchEvent(ev);
			return ev;
		}
		function dispatchClick(target, tag) {
			const ev = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window });
			ev.__dpoTag = tag || "dpo";
			target.dispatchEvent(ev);
			return ev;
		}
		/** 冒泡期间谍：只认本次派发的那个事件，用户真实按键记为 other（不污染判定）。 */
		const probeArtifacts = new Set();
		function releaseProbeArtifacts() {
			for (const fn of [...probeArtifacts]) { try { fn(); } catch (e) { /* noop */ } }
			probeArtifacts.clear();
		}
		function spyBubble(type, tag) {
			const box = { reached: false, other: 0 };
			const fn = (e) => {
				if (!tag) { box.reached = true; return; }
				if (e.__dpoTag === tag) box.reached = true;
				else box.other += 1;
			};
			window.addEventListener(type, fn, false);
			const stop = () => { window.removeEventListener(type, fn, false); probeArtifacts.delete(stop); };
			probeArtifacts.add(stop);
			return { box, stop };
		}

		async function post(path, body) {
			const res = await fetch(API + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return res.json().catch(() => ({}));
		}

		/** 若应用在"本应被拦"的路径上仍把消息排进官方队列，则请宿主撤销该待处理项（零污染）。 */
		async function cleanupQueued(ctx, marker) {
			const snap = sessionOf();
			const row = (snap.queue || []).find((r) => String(r.text || "").includes(marker));
			if (!row) return { found: false };
			let removed = false;
			let error = null;
			try {
				const res = await post("/queued/remove", { sessionId: store.latest.sessionId, itemId: row.id });
				if (!res || res.ok !== true) error = (res && res.error) || "remove-failed";
				await sleep(700);
				removed = !(sessionOf().queue || []).some((r) => r.id === row.id);
			} catch (e) { error = String(e); }
			return { found: true, itemId: row.id, removed, error };
		}

		async function runProbe(ctx, token) {
			releaseProbeArtifacts();
			const steps = [];
			// 探针会改写档位/权限/浮层几何：先快照，收尾时还原成用户的值（探针不得改变用户配置）
			const uiSnapshot = {
				tier: store.tier,
				permission: store.permission,
				size: store.overlaySize ? Object.assign({}, store.overlaySize) : null,
				pos: store.overlayPos ? Object.assign({}, store.overlayPos) : null,
			};
			store.probeUiSnapshot = uiSnapshot;
			const push = (id, name, action, expected, observed, pass) =>
				steps.push({ id, name, action, expected, observed, pass: pass === true });
			const windowStart = Date.now();
			const actions = store.latest.actions;
			const initialDraft = draftFromHook();
			const card = cardOf(store.node);
			const editor = editorOf(card);
			const sendBtn = sendButtonOf(card);
			const pill = card ? card.querySelector('[data-dpo="pill"]') : null;

			push("S0", "骨架在位", "读取真实 DOM 结构",
				"卡片/编辑器/发送按钮均定位到",
				{
					card: Boolean(card), editor: Boolean(editor), sendButton: Boolean(sendBtn),
					sendLabel: sendBtn ? sendBtn.getAttribute("aria-label") : null,
					labelSet: [...SEND_LABELS],
					cardButtons: buttonsOf(card).map((b) => b.getAttribute("aria-label")),
					lastButton: lastButtonOf(card) ? lastButtonOf(card).getAttribute("aria-label") : null,
					sessionId: String(store.latest.sessionId || ""),
					running: runningNow(),
					actions: Boolean(actions),
				},
				Boolean(card && editor && sendBtn && actions));

			// ENV 闸门：环境不齐备就整轮中止，避免在被切换后的会话上误测（t15 的教训）
			const envPerm = buttonsOf(card).find((b) => String(b.getAttribute("aria-label")).includes("访问模式"));
			const envModel = buttonsOf(card).find((b) => String(b.getAttribute("aria-label")).includes("选择模型"));
			const envReady = Boolean(card && editor && actions && envPerm && envModel);
			if (!envReady && !(window.__DPO_FORCE_ENV__ === true)) {
				const aborted = {
					plugin: NS, token, kind: "selftest-aborted", reason: "environment-not-ready",
					sessionId: String(store.latest.sessionId || ""), windowStart, windowEnd: Date.now(),
					env: {
						card: Boolean(card), editor: Boolean(editor), actions: Boolean(actions),
						permissionSelect: Boolean(envPerm), modelSeat: Boolean(envModel), running: runningNow(),
					},
					steps, passed: 0, total: steps.length,
				};
				try { await post("/report", aborted); } catch (e) { /* noop */ }
				window.__DPO_PROBE_RUNNING__ = false;
				return aborted;
			}

			if (editor && actions) {
				// ── E2：IME 组合态回车不得误拦 ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-IME-组合态测试");
				await frame();
				if (editor) editor.focus();
				const before2 = store.intercepts.length;
				const spy2 = spyBubble("keydown", "e2");
				const ev2 = dispatchKey(editor, { isComposing: true }, "e2");
				await sleep(400);
				spy2.stop();
				const clean2 = await cleanupQueued(ctx, "DPO-IME-组合态测试");
				const pass2 = store.intercepts.length === before2 && !store.overlay.open;
				push("E2", "IME 组合态回车不误拦",
					"setDraft→focus→派发 isComposing:true 的 Enter",
					"拦截计数不变、占位浮层不出现、消息不落库",
					{ interceptsBefore: before2, interceptsAfter: store.intercepts.length, overlayOpen: store.overlay.open, defaultPrevented: ev2.defaultPrevented, reachedBubble: spy2.box.reached, other: spy2.box.other, queuedCleanup: clean2 },
					pass2);
				if (actions) actions.setDraft("");
				await frame();

				// ── E1：正常回车必须被拦 ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-回车拦截测试：把那个东西弄一下");
				await frame();
				if (editor) editor.focus();
				const before1 = store.intercepts.length;
				const spy1 = spyBubble("keydown", "e1");
				const ev1 = dispatchKey(editor, {}, "e1");
				await sleep(400);
				spy1.stop();
				const last1 = store.intercepts[store.intercepts.length - 1] || {};
				const clean1 = await cleanupQueued(ctx, "DPO-回车拦截测试");
				const pass1 = store.intercepts.length === before1 + 1 && store.overlay.open === true && spy1.box.reached === false;
				push("E1", "正常回车被拦截",
					"setDraft→focus→派发普通 Enter",
					"拦截计数 +1、占位浮层出现、事件未传播到冒泡期、消息不落库",
					{ interceptsBefore: before1, interceptsAfter: store.intercepts.length, overlayOpen: store.overlay.open, overlaySrc: store.overlay.src, overlayText: String(store.overlay.text).slice(0, 60), reachedBubble: spy1.box.reached, other: spy1.box.other, defaultPrevented: ev1.defaultPrevented, interceptedKind: last1.kind, queuedCleanup: clean1 },
					pass1);
				if (actions) actions.setDraft("");
				setOverlay({ open: false });
				await frame();

				// ── E4：对照——非发送按钮一律不得被拦（逐按钮求值 + 编辑器点击行为） ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-对照测试：随便写点什么");
				await frame();
				const cardNow = cardOf(store.node);
				const table = buttonsOf(cardNow).map((b) => ({
					label: b.getAttribute("aria-label"),
					would: wouldInterceptClick(b),
					byLabel: isSendLabel(b.getAttribute("aria-label")),
					isLast: lastButtonOf(cardNow) === b,
					isStop: STOP_LABELS.has(b.getAttribute("aria-label") || ""),
				}));
				const trueCount = table.filter((r) => r.would).length;
				const before4 = store.intercepts.length;
				if (editor) dispatchClick(editor, "e4");
				await sleep(200);
				const pass4 = trueCount === 1 && store.intercepts.length === before4;
				push("E4", "非发送按钮不拦截（对照）",
					"对卡片内每个按钮求值 wouldInterceptClick + 向编辑器派发 click",
					"仅发送按钮被判为接管（1 个 true）；编辑器点击不触发拦截",
					{ table, trueCount, interceptsBefore: before4, interceptsAfter: store.intercepts.length },
					pass4);
				setOverlay({ open: false });
				if (actions) actions.setDraft("");
				await frame();

				// ── E3：真实发送按钮 click 必须被拦（先放入草稿，主按钮此时才是"发送"角色） ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-按钮拦截测试：把那个东西弄一下");
				await frame();
				const liveSend = sendButtonOf(card) || sendBtn;
				const before3 = store.intercepts.length;
				let reachedClick = null;
				if (liveSend) {
					const spy3 = spyBubble("click", "e3");
					const ev3 = dispatchClick(liveSend, "e3");
					await sleep(400);
					spy3.stop();
					reachedClick = spy3.box.reached;
					const spy3Other = spy3.box.other;
					const clean3 = await cleanupQueued(ctx, "DPO-按钮拦截测试");
					const pass3 = store.intercepts.length === before3 + 1 && store.overlay.open === true && reachedClick === false;
					push("E3", "发送按钮 click 被拦截",
						"setDraft→派发 click 到主按钮（标签或结构位命中）",
						"拦截计数 +1、占位浮层出现、事件未传播、消息不落库",
						{ interceptsBefore: before3, interceptsAfter: store.intercepts.length, overlayOpen: store.overlay.open, overlaySrc: store.overlay.src, reachedBubble: reachedClick, other: spy3Other, label: liveSend.getAttribute("aria-label"), byLabel: isSendLabel(liveSend.getAttribute("aria-label")), isLast: lastButtonOf(card) === liveSend, defaultPrevented: ev3.defaultPrevented, queuedCleanup: clean3 },
						pass3);
				} else {
					push("E3", "发送按钮 click 被拦截", "派发 click 到真实发送按钮", "命中并拦截", { error: "未定位到发送按钮" }, false);
				}
				if (actions) actions.setDraft("");
				setOverlay({ open: false });
				await frame();

				// ── E5：setDraft → 投影回读（中文 / 超长） ──
				const cn = "中文草稿：把那个东西弄一下，尽量说清楚";
				if (actions) actions.setDraft(cn);
				await frame();
				const back1 = draftFromHook();
				const long = "长文本测试：" + "段落内容".repeat(300);
				if (actions) actions.setDraft(long);
				await frame();
				const back2 = draftFromHook();
				const pass5 = back1 === cn && back2 === long;
				push("E5", "setDraft 投影回读",
					"setDraft(中文) → 回读；setDraft(超长) → 回读",
					"两次回读与写入完全一致",
					{ cnLen: cn.length, cnBackLen: back1.length, cnEqual: back1 === cn, longLen: long.length, longBackLen: back2.length, longEqual: back2 === long },
					pass5);
				if (actions) actions.setDraft("");
				await frame();

				// ── E6：交付链路 + 正控（需会话 running，避免污染） ──
				if (!runningNow()) {
					push("E6", "交付链路+正控", "临时解除拦截后派发 Enter", "文本进入官方待处理队列并可撤销",
						{ skipped: true, reason: "会话当前非 running（idle 提交会直接落库，故意不测）" }, false);
				} else {
					const marker = "DPO-交付链路测试-" + token;
					store.armed = false;
					if (actions) actions.setDraft(marker);
					await frame();
					if (editor) editor.focus();
					const echoBefore = (sessionOf().pendingSubmissions || []).length;
					dispatchKey(editor, {}, "g");
					// 轮询等待"进入官方链路"的取证（最多 ~3.6s，避开单次采样竞态）
					let rowObserved = null;
					for (let i = 0; i < 12 && rowObserved === null; i += 1) {
						await sleep(300);
						rowObserved = (sessionOf().queue || []).find((r) => String(r.text || "").includes(marker)) || null;
					}
					const snap = sessionOf();
					const echoAfter = (snap.pendingSubmissions || []).length;
					// 宿主权威撤销：按文本匹配，不依赖客户端快照能否及时看到该行
					let removedByText = null;
					try { removedByText = await post("/queued/remove-by-text", { match: marker }); } catch (e) { removedByText = { error: String(e) }; }
					await sleep(700);
					const stillInQueue = (sessionOf().queue || []).some((r) => String(r.text || "").includes(marker));
					store.armed = true;
					if (actions) actions.setDraft("");
					const removedCount = removedByText && Array.isArray(removedByText.removed) ? removedByText.removed.length : 0;
					const pass6 = removedCount > 0 && stillInQueue === false;
					push("E6", "交付链路+正控",
						"解除拦截 → setDraft(标记文本) → 派发 Enter → 观察官方队列 → 宿主按文本权威撤销",
						"合成事件抵达官方发送入口（官方队列/收件箱出现该文本）、setDraft 内容被完整提交、撤销后队列干净",
						{ running: true, echoBefore, echoAfter, queuedRowObserved: Boolean(rowObserved), queuedText: rowObserved ? String(rowObserved.text).slice(0, 60) : null, removedByText, removedCount, stillInQueue },
						pass6);
				}
			}

			// ══════════ 1.2 三控件落位 ══════════
			const controlsEl = store.node;
			const cardF = cardOf(controlsEl);
			const rectOf = (el) => {
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
			};
			const officialButtons = () => buttonsOf(cardF).filter((b) => b.getAttribute("aria-label") && !(b.closest && b.closest('[data-dpo="controls"]')));
			const snapshotRects = () => officialButtons().map((b) => ({ label: b.getAttribute("aria-label"), r: rectOf(b) }));
			const follows = (a, b) => Boolean(a && b) && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

			const tierEl = cardF ? cardF.querySelector('[data-dpo="tier"]') : null;
			const permEl = cardF ? cardF.querySelector('[data-dpo="perm"]') : null;
			const modelEl = cardF ? cardF.querySelector('[data-dpo="model"]') : null;
			const permOfficial = officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式"));
			const modelOfficial = officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("选择模型"));
			const sameRow = rectOf(tierEl) && rectOf(permOfficial) ? Math.abs(rectOf(tierEl).y - rectOf(permOfficial).y) <= 2 : false;
			const f1pass = Boolean(tierEl && permEl && modelEl && permOfficial && modelOfficial)
				&& follows(permOfficial, tierEl) && follows(tierEl, permEl) && follows(permEl, modelEl) && follows(modelEl, modelOfficial)
				&& sameRow;
			push("F1", "三控件落位",
				"定位三个控件，并与官方「访问模式」「选择模型」做文档顺序 + 几何核对",
				"三控件存在；顺序为 权限设置 → 档位 → 权限 → 模型入口 → 官方模型座位；与权限设置同一行",
				{
					exists: { tier: Boolean(tierEl), perm: Boolean(permEl), model: Boolean(modelEl), permOfficial: Boolean(permOfficial), modelOfficial: Boolean(modelOfficial) },
					order: { permBeforeTier: follows(permOfficial, tierEl), tierBeforePerm: follows(tierEl, permEl), permBeforeModel: follows(permEl, modelEl), modelBeforeOfficial: follows(modelEl, modelOfficial) },
					rects: { tier: rectOf(tierEl), perm: rectOf(permEl), model: rectOf(modelEl), permOfficial: rectOf(permOfficial), modelOfficial: rectOf(modelOfficial) },
					sameRow,
					text: { tier: tierEl ? tierEl.textContent : null, perm: permEl ? permEl.textContent : null, model: modelEl ? modelEl.textContent : null },
				},
				f1pass);

			const segBtn = (name, id) => (cardF ? cardF.querySelector('[data-dpo="' + name + "-" + id + '"]') : null);
			const permButtons = permEl ? Array.from(permEl.querySelectorAll("button")) : [];
			const tierBeforeF2 = store.tier;
			const permBeforeF2 = store.permission;
			const offBtn = segBtn("tier", "off");
			if (offBtn) dispatchClick(offBtn);
			await sleep(200);
			const offState = {
				tier: store.tier, armed: store.armed,
				disabled: permButtons.map((b) => b.disabled),
				permOpacity: permEl ? getComputedStyle(permEl).opacity : null,
			};
			const permBeforeClick = store.permission;
			if (permButtons[1]) dispatchClick(permButtons[1]);
			await sleep(120);
			const permAfterClickWhileOff = store.permission;
			const basicBtn = segBtn("tier", "basic");
			if (basicBtn) dispatchClick(basicBtn);
			await sleep(200);
			const onState = {
				tier: store.tier, armed: store.armed,
				disabled: permButtons.map((b) => b.disabled),
				permOpacity: permEl ? getComputedStyle(permEl).opacity : null,
			};
			if (permButtons[1]) dispatchClick(permButtons[1]);
			await sleep(120);
			const permAfterClickWhileOn = store.permission;
			const f2pass = permButtons.length === 2
				&& offState.disabled.every((d) => d === true)
				&& offState.armed === false
				&& permAfterClickWhileOff === permBeforeClick
				&& onState.disabled.every((d) => d === false)
				&& onState.armed === true
				&& permAfterClickWhileOn === "auto";
			push("F2", "档位=关闭 → 权限置灰联动",
				"真实点击「关闭」段 → 试点权限段 → 点回「普通」段 → 再点权限段",
				"关闭档：权限段 disabled 且点击无效、拦截停用；回到普通档：权限段恢复可点且能切换",
				{ offState, permBeforeClick, permAfterClickWhileOff, onState, permAfterClickWhileOn, permOpacityOff: offState.permOpacity, permOpacityOn: onState.permOpacity },
				f2pass);
			setPermission("review", "probe-reset");
			if (tierBeforeF2 !== store.tier) setTier(tierBeforeF2, "probe-restore");
			if (permBeforeF2 === "auto") setPermission("auto", "probe-restore");

			const beforeA = snapshotRects();
			if (controlsEl) controlsEl.style.display = "none";
			await frame();
			const withoutOurs = snapshotRects();
			if (controlsEl) controlsEl.style.display = "";
			await frame();
			const afterA = snapshotRects();
			const drift = [];
			for (const item of beforeA) {
				const other = withoutOurs.find((x) => x.label === item.label);
				if (!other) { drift.push({ label: item.label, missingWhenHidden: true }); continue; }
				if (Math.abs(other.r.x - item.r.x) > 1 || Math.abs(other.r.w - item.r.w) > 1 || Math.abs(other.r.y - item.r.y) > 1) {
					drift.push({ label: item.label, withOurs: item.r, hidden: other.r });
				}
			}
			const overflow = controlsEl ? { scrollW: controlsEl.scrollWidth, clientW: controlsEl.clientWidth } : null;
			const restored = beforeA.every((item) => {
				const back = afterA.find((x) => x.label === item.label);
				return back && Math.abs(back.r.x - item.r.x) <= 1 && Math.abs(back.r.w - item.r.w) <= 1;
			});
			const f3pass = beforeA.length >= 5 && drift.length === 0 && (!overflow || overflow.scrollW <= overflow.clientW + 1) && restored;
			push("F3", "零位移/零遮挡（A/B）",
				"记录官方控件 rect → 隐藏本插件控件 → 复测 → 恢复后再测",
				"隐藏前后官方控件 rect 完全一致（±1px）；本插件内容不横向溢出；恢复后位置回到原样",
				{ officialCount: beforeA.length, drift, overflow, restored, ourRect: rectOf(controlsEl), samples: beforeA.slice(0, 4) },
				f3pass);

			// ══════════ 1.3 手势边界与放行白名单 ══════════
			const fakeEnter = (over) => Object.assign({
				key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
				isComposing: false, keyCode: 13,
			}, over || {});
			const passRows = [];

			// G1：Shift+Enter 换行（真实派发）
			if (actions) actions.setDraft("DPO-换行测试");
			await frame();
			if (editor) editor.focus();
			let gBefore = store.intercepts.length;
			let gSpy = spyBubble("keydown", "g");
			dispatchKey(editor, { shiftKey: true }, "g");
			await sleep(300);
			gSpy.stop();
			passRows.push({
				id: "G1", name: "Shift+Enter 换行", mode: "真实派发",
				intercepted: store.intercepts.length > gBefore,
				reachedBubble: gSpy.box.reached,
				draftLenAfter: draftLive().length,
				hasNewline: draftLive().includes("\n"),
			});

			// G5：卡片外回车（临时 input 挂在 body 上，等价于设置页/重命名框）
			const outsideInput = document.createElement("input");
			outsideInput.setAttribute("data-dpo-probe", "outside");
			outsideInput.style.cssText = "position:fixed;left:-9999px;top:0";
			document.body.appendChild(outsideInput);
			probeArtifacts.add(() => { try { outsideInput.remove() } catch (e) { /* noop */ } });
			outsideInput.focus();
			await sleep(80);
			const gCard = cardOf(store.node);
			gBefore = store.intercepts.length;
			gSpy = spyBubble("keydown", "g");
			const g5Event = dispatchKey(outsideInput, {}, "g");
			await sleep(250);
			gSpy.stop();
			passRows.push({
				id: "G5", name: "卡片外回车（设置页/重命名框同类）", mode: "真实派发",
				activeOutsideCard: Boolean(gCard && !gCard.contains(document.activeElement)),
				intercepted: store.intercepts.length > gBefore,
				reachedBubble: gSpy.box.reached,
				defaultPrevented: g5Event.defaultPrevented,
			});
			outsideInput.remove();
			if (editor) editor.focus();
			await sleep(80);

			// G2：空白草稿（等价空草稿 steer 手势；真实派发）
			if (actions) actions.setDraft("   ");
			await frame();
			if (editor) editor.focus();
			gBefore = store.intercepts.length;
			const g2QueueBefore = (sessionOf().queue || []).length;
			gSpy = spyBubble("keydown", "g");
			dispatchKey(editor, {}, "g");
			await sleep(400);
			gSpy.stop();
			const g2QueueAfter = (sessionOf().queue || []).length;
			passRows.push({
				id: "G2", name: "空白草稿（空草稿 steer 手势）", mode: "真实派发",
				intercepted: store.intercepts.length > gBefore,
				reachedBubble: gSpy.box.reached,
				queueBefore: g2QueueBefore, queueAfter: g2QueueAfter,
			});
			if (actions) actions.setDraft("");
			await frame();

			// G3：/ 命令 —— 真实派发（用已注册的 /permission；popupSelect 型：只进入 claimed，不落任何副作用）
			if (actions) actions.setDraft("/goal 边界测试");
			await frame();
			if (editor) editor.focus();
			const g3Predicate = interceptKey(fakeEnter());
			const g3AccessBefore = (officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式")) || {}).getAttribute
				? officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式")).getAttribute("aria-label")
				: null;
			if (actions) actions.setDraft("/permission");
			await frame();
			if (editor) editor.focus();
			const g3CountBefore = store.intercepts.length;
			const g3Spy = spyBubble("keydown", "g3");
			const g3Event = dispatchKey(editor, {}, "g3");
			await sleep(600);
			g3Spy.stop();
			const g3Input = store.latest.input || {};
			const g3Claim = g3Input.claim && g3Input.claim.token ? String(g3Input.claim.token) : null;
			if (actions) actions.setDraft("");
			await frame();
			dispatchKey(editor, { key: "Escape", code: "Escape" }, "g3esc");
			await sleep(250);
			const g3AccessAfter = officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式"));
			passRows.push({
				id: "G3", name: "/ 命令", mode: "真实派发（/permission，popupSelect 型）",
				predicate: g3Predicate,
				intercepted: store.intercepts.length > g3CountBefore,
				reachedBubble: g3Spy.box.reached,
				other: g3Spy.box.other,
				defaultPrevented: g3Event.defaultPrevented,
				phaseAfterDispatch: g3Input.phase || null,
				claimToken: g3Claim,
				officialEngaged: g3Claim === "/permission" || g3Input.phase === "claimed" || g3Input.phase === "submitting",
				accessUnchanged: g3AccessBefore === (g3AccessAfter ? g3AccessAfter.getAttribute("aria-label") : g3AccessBefore),
			});
			if (actions) actions.setDraft("");
			await frame();

			// G4：仅附件（草稿无文本 ⇒ 同一放行分支；真附件上传无法在探针内构造）
			if (editor) editor.focus();
			const g4Key = interceptKey(fakeEnter());
			const g4Click = wouldInterceptClick(sendButtonOf(cardOf(store.node)));
			passRows.push({
				id: "G4", name: "仅附件发送（草稿文本为空）", mode: "谓词级（判定只看草稿文本）",
				keyPredicate: g4Key, clickPredicate: g4Click,
			});

			// G6：fail-open（复用 E6 正控）+ 无重复 + 无卡死
			const e6 = steps.find((s) => s.id === "E6") || { observed: {} };
			const alive = {
				controlsAlive: Boolean(cardOf(store.node) && cardOf(store.node).querySelector('[data-dpo="controls"]')),
				tier: store.tier, armed: store.armed,
				editorFocusable: Boolean(editorOf(cardOf(store.node))),
				interceptCount: store.intercepts.length,
			};
			const rowsPass = passRows.filter((row) => row.mode === "真实派发").every((row) => row.intercepted === false && row.reachedBubble === true)
				&& g3Predicate === false && g4Key === false && g4Click === false;
			push("G", "放行白名单与 fail-open",
				"逐条复现放行清单（真实派发 + 谓词级）并核对 fail-open 正控",
				"五条放行项均不被接管且事件继续传播；未命中时官方链路照常发出（无重复、无卡死）",
				{
					passRows, alive,
					failOpen: { e6QueuedRowObserved: e6.observed.queuedRowObserved, e6RemovedCount: e6.observed.removedCount, e6StillInQueue: e6.observed.stillInQueue, e6QueuedText: e6.observed.queuedText },
				},
				rowsPass && alive.controlsAlive && alive.armed === true && Boolean(e6.observed.queuedRowObserved));

			// I1：查证 trace 在浮层里可见（小类 2.3 验收 3，渲染层机检）
			let tracePayload = null;
			try { tracePayload = await (await fetch(API + "/trace", { cache: "no-store" })).json(); } catch (e) { tracePayload = { error: String(e) }; }
			store.trace = tracePayload && tracePayload.ok ? tracePayload : null;
			setOverlay({ open: true, text: "查证 trace 渲染测试", src: "i1" });
			await frame();
			await sleep(150);
			const traceRowEls = document.querySelectorAll('[data-dpo="trace-row"]');
			const traceHostEl = document.querySelector('[data-dpo="trace"]');
			const i1pass = Boolean(tracePayload && tracePayload.ok)
				&& Array.isArray(tracePayload.normal) && tracePayload.normal.length > 0
				&& Boolean(traceHostEl) && traceRowEls.length > 0;
			push("I1", "查证动作在浮层可见",
				"拉取 /trace → 打开占位浮层 → 统计渲染出的 trace 行",
				"接口有数据且浮层内渲染出 ≥1 行查证动作（工具/参数/耗时/结果行数）",
				{
					apiOk: Boolean(tracePayload && tracePayload.ok),
					normalSteps: tracePayload && Array.isArray(tracePayload.normal) ? tracePayload.normal.length : null,
					cappedSteps: tracePayload && Array.isArray(tracePayload.capped) ? tracePayload.capped.length : null,
					converged: tracePayload ? tracePayload.converged : null,
					renderedRows: traceRowEls.length,
					hostPresent: Boolean(traceHostEl),
					sample: Array.from(traceRowEls).slice(0, 3).map((el) => String(el.textContent).slice(0, 60)),
				}, i1pass);
			setOverlay({ open: false });
			await frame();
			// J1：可拖动浮层（跟手 / 越界约束 / 点击穿透 / 关闭即清理）
			// 探针期间禁止把几何写进用户偏好，并在结束时还原（用户文件不被测试改写）
			const jUiSnapshot = { size: store.overlaySize ? Object.assign({}, store.overlaySize) : null, pos: store.overlayPos ? Object.assign({}, store.overlayPos) : null };
			store.suppressUiPersist = true;
			store.overlayPos = { x: 220, y: 140 };
			setOverlay({ open: true, text: "拖动测试文本", src: "j1" });
			await frame();
			await sleep(140);
			const jPanel = document.querySelector('[data-dpo="overlay"]');
			const jHead = jPanel ? jPanel.querySelector('[data-dpo="drag-handle"]') : null;
			const jLayer = jPanel ? jPanel.parentElement : null;
			const jRenderBefore = store.renderCount || 0;
			const jR0 = jPanel ? jPanel.getBoundingClientRect() : null;
			const jPt = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, button: 0, clientX: x, clientY: y });
			if (jHead && jPanel) {
				const sx = jR0.left + Math.round(jR0.width / 2); const sy = jR0.top + 10;
				jHead.dispatchEvent(jPt("pointerdown", sx, sy));
				for (let i = 1; i <= 8; i += 1) jHead.dispatchEvent(jPt("pointermove", sx + 15 * i, sy + 10 * i));
				jHead.dispatchEvent(jPt("pointerup", sx + 120, sy + 80));
			}
			await frame();
			await sleep(90);
			const jR1 = jPanel ? jPanel.getBoundingClientRect() : null;
			const jFollow = jR0 && jR1 ? { dx: Math.round(jR1.left - jR0.left), dy: Math.round(jR1.top - jR0.top) } : null;
			const jRenders = (store.renderCount || 0) - jRenderBefore;
			if (jHead && jPanel) {
				const sx = jR1.left + Math.round(jR1.width / 2); const sy = jR1.top + 10;
				jHead.dispatchEvent(jPt("pointerdown", sx, sy));
				jHead.dispatchEvent(jPt("pointermove", sx + 5000, sy + 5000));
				jHead.dispatchEvent(jPt("pointerup", sx + 5000, sy + 5000));
			}
			await frame();
			await sleep(90);
			const jR2 = jPanel ? jPanel.getBoundingClientRect() : null;
			const jInView = Boolean(jR2) && jR2.left >= 0 && jR2.top >= 0 && jR2.right <= window.innerWidth + 1 && jR2.bottom <= window.innerHeight + 1;
			const jLayerPe = jLayer ? getComputedStyle(jLayer).pointerEvents : null;
			const jPanelPe = jPanel ? getComputedStyle(jPanel).pointerEvents : null;
			const jOutsideEl = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight - 60));
			const jOutsideOurs = Boolean(jOutsideEl && jOutsideEl.closest && jOutsideEl.closest('[data-dpo="overlay"]'));
			const jInsideEl = jR2 ? document.elementFromPoint(Math.round(jR2.left + 12), Math.round(jR2.top + 12)) : null;
			const jInsideOurs = Boolean(jInsideEl && jInsideEl.closest && jInsideEl.closest('[data-dpo="overlay"]'));
			// J1b：把"上一次在更大窗口里留下的视口外坐标"写回 → 重新开窗必须被夹回可见区（用户实测缺陷回归）
			store.overlayPos = { x: window.innerWidth + 4000, y: window.innerHeight + 4000 };
			setOverlay({ open: true });
			await frame();
			await sleep(150);
			const jPanel3 = document.querySelector('[data-dpo="overlay"]');
			const jR3 = jPanel3 ? jPanel3.getBoundingClientRect() : null;
			const jClampOnOpen = Boolean(jR3) && jR3.left >= 0 && jR3.top >= 0
				&& jR3.right <= window.innerWidth + 1 && jR3.bottom <= window.innerHeight + 1;
			const jClampObserved = jR3 ? { left: Math.round(jR3.left), top: Math.round(jR3.top), right: Math.round(jR3.right), bottom: Math.round(jR3.bottom) } : null;
			// J1c：右下角手柄拖拽改尺寸（变大/变小都验），且不得超过视口
			const jGrip = document.querySelector('[data-dpo="resize"]');
			let jResize = null;
			if (jGrip && jPanel3) {
				const r0 = jPanel3.getBoundingClientRect();
				const gx = r0.right - 6; const gy = r0.bottom - 6;
				jGrip.dispatchEvent(jPt("pointerdown", gx, gy));
				jGrip.dispatchEvent(jPt("pointermove", gx - 120, gy - 90));
				jGrip.dispatchEvent(jPt("pointerup", gx - 120, gy - 90));
				await frame();
				await sleep(140);
				const r1 = jPanel3.getBoundingClientRect();
				jResize = {
					w0: Math.round(r0.width), h0: Math.round(r0.height), w1: Math.round(r1.width), h1: Math.round(r1.height),
					dw: Math.round(r1.width - r0.width), dh: Math.round(r1.height - r0.height),
					persisted: store.overlaySize || null,
					withinViewport: r1.right <= window.innerWidth + 1 && r1.bottom <= window.innerHeight + 1,
				};
			}
			const jResizeOk = Boolean(jResize) && jResize.dw <= -100 && jResize.dw >= -140 && jResize.dh <= -70 && jResize.dh >= -110 && jResize.withinViewport === true;
			// J1d：点击守卫回归——在「回退」按钮上按下：不得 preventDefault（否则 click 被浏览器抑制）、不得启动拖动
			const jRollbackBtn = document.querySelector('[data-dpo="rollback"]');
			let jGuard = null;
			if (jRollbackBtn && jPanel3) {
				const bb = jRollbackBtn.getBoundingClientRect();
				const before = jPanel3.getBoundingClientRect();
				const downEv = jPt("pointerdown", bb.left + 4, bb.top + 4);
				jRollbackBtn.dispatchEvent(downEv);
				jRollbackBtn.dispatchEvent(jPt("pointermove", bb.left + 220, bb.top + 160));
				jRollbackBtn.dispatchEvent(jPt("pointerup", bb.left + 220, bb.top + 160));
				await frame();
				await sleep(90);
				const after = jPanel3.getBoundingClientRect();
				jGuard = {
					defaultPrevented: downEv.defaultPrevented === true,
					moved: Math.round(Math.abs(after.left - before.left) + Math.abs(after.top - before.top)),
					reachable: (() => { const el = document.elementFromPoint(Math.round(bb.left + 4), Math.round(bb.top + 4)); return Boolean(el && el.closest && el.closest('[data-dpo="rollback"]')); })(),
				};
			}
			const jGuardOk = Boolean(jGuard) && jGuard.defaultPrevented === false && jGuard.moved === 0 && jGuard.reachable === true;
			setOverlay({ open: false });
			// 几何还原：探针不改变用户的浮层尺寸/位置偏好
			store.suppressUiPersist = false;
			store.overlaySize = jUiSnapshot.size;
			store.overlayPos = jUiSnapshot.pos;
			await frame();
			await sleep(140);
			const jGone = !document.querySelector('[data-dpo="overlay"]');
			const jListeners = store.resizeListeners || 0;
			const jSendBtn = sendButtonOf(cardOf(store.node));
			let jSendReachable = null;
			if (jSendBtn) {
				const rb = jSendBtn.getBoundingClientRect();
				const el = document.elementFromPoint(Math.round(rb.left + rb.width / 2), Math.round(rb.top + rb.height / 2));
				jSendReachable = Boolean(el && (el === jSendBtn || (el.closest && el.closest("button") === jSendBtn)));
			}
			const j1pass = Boolean(jFollow) && Math.abs(jFollow.dx - 120) <= 6 && Math.abs(jFollow.dy - 80) <= 6
				&& jInView && jPanelPe === "auto" && !jOutsideOurs && jInsideOurs && jSendReachable === true
				&& jGone && jListeners === 0 && jRenders <= 2
				&& jClampOnOpen === true && jResizeOk === true && jGuardOk === true;
			push("J1", "可拖动浮层（跟手/边界/穿透/清理/开窗夹紧/改尺寸）",
				"合成 pointerdown→move×8→up 位移(+120,+80)；再拖 +5000；elementFromPoint 验穿透；写回视口外旧坐标后重开；右下角手柄拖拽改尺寸；关闭后查 DOM 与监听计数",
				"位移与手势 1:1（±6px）、面板始终在视口内、容器穿透/面板可点、视口外旧坐标重开后仍在可见区、右下角可改尺寸且不越界、关闭后节点与监听均清理、拖动期间 React 渲染 ≤2",
				{
					follow: jFollow, inView: jInView, layerPointerEvents: jLayerPe, panelPointerEvents: jPanelPe, sendReachable: jSendReachable,
					outsideHitsOurs: jOutsideOurs, insideHitsOurs: jInsideOurs, closedRemoved: jGone,
					resizeListenersAfterClose: jListeners, rendersDuringDrag: jRenders,
					clampOnOpen: jClampOnOpen, clampObserved: jClampObserved, resize: jResize, resizeOk: jResizeOk, clickGuard: jGuard, guardOk: jGuardOk,
					rectAfterClamp: jR2 ? { left: Math.round(jR2.left), top: Math.round(jR2.top), right: Math.round(jR2.right), bottom: Math.round(jR2.bottom) } : null,
					viewport: { w: window.innerWidth, h: window.innerHeight },
				}, j1pass);
			// K1：流式思考与产出（分区 / 增量 / 首字 / 失败态 / 重试）
			const kReq = "把那个页面弄好看点，动画也加上";
			const kT0 = Date.now();
			startRun(kReq, "basic", false);
			await frame();
			let kFirst = null;
			for (let i = 0; i < 60 && kFirst === null; i += 1) {
				await sleep(100);
				const r = store.run;
				if (r && (r.reasoning.length > 0 || r.text.length > 0)) kFirst = Date.now() - kT0;
			}
			const kPaneREarly = Boolean(document.querySelector('[data-dpo="pane-reasoning"]'));
			const kPaneTEarly = Boolean(document.querySelector('[data-dpo="pane-text"]'));
			const kSnap1 = { r: store.run.reasoning.length, t: store.run.text.length };
			await sleep(2500);
			const kSnap2 = { r: store.run.reasoning.length, t: store.run.text.length };
			for (let i = 0; i < 160 && store.run.status === "running"; i += 1) await sleep(250);
			const kRun = store.run;
			const kReason = kRun.reasoning || "";
			const kText = kRun.text || "";
			const kPaneR = document.querySelector('[data-dpo="pane-reasoning"]');
			const kPaneT = document.querySelector('[data-dpo="pane-text"]');
			// 通道身份判据：两栏渲染内容必须分别对应各自事件流的累积（思考通道可能引用结构标题，不能拿标题当判据）
			const kPaneRText = kPaneR ? String(kPaneR.textContent || "") : "";
			const kPaneTText = kPaneT ? String(kPaneT.textContent || "") : "";
			const kRSample = kReason.slice(0, 40);
			const kTSample = kText.slice(0, 40);
			const kSeparated = Boolean(kPaneR && kPaneT)
				&& kPaneR !== kPaneT
				&& kPaneRText !== kPaneTText
				&& (kRSample.length === 0 || kPaneRText.indexOf(kRSample) >= 0)
				&& (kTSample.length === 0 || kPaneTText.indexOf(kTSample) >= 0)
				&& (kReason.length === 0 || kText.length === 0 || kPaneRText.indexOf(kTSample) < 0);
			// 失败态：真实失败路径（未注册 provider）
			startRun(kReq, "basic", true);
			await frame();
			for (let i = 0; i < 100 && store.run.status !== "error" && store.run.status !== "done"; i += 1) await sleep(200);
			const kErrNode = document.querySelector('[data-dpo="run-error"]');
			const kRetryBtn = document.querySelector('[data-dpo="retry"]');
			const kFail = {
				status: store.run.status,
				error: String(store.run.error || "").slice(0, 160),
				errorNodeText: kErrNode ? String(kErrNode.textContent).slice(0, 160) : null,
				hasRetry: Boolean(kRetryBtn),
				textEmpty: (store.run.text || "").length === 0,
			};
			let kRecovered = false;
			if (kRetryBtn) {
				dispatchClick(kRetryBtn, "k1retry");
				for (let i = 0; i < 160 && (store.run.status === "running" || (store.run.text || "").length === 0); i += 1) await sleep(250);
				kRecovered = store.run.status === "done" && (store.run.text || "").length > 0 && !store.run.error;
			}
			const k1pass = kFirst !== null && kFirst <= 2000 && kPaneREarly && kPaneTEarly
				&& (kSnap2.r + kSnap2.t) > (kSnap1.r + kSnap1.t) && kSeparated
				&& kFail.status === "error" && kFail.error.length > 0 && kFail.hasRetry && kFail.textEmpty
				&& kRecovered === true;
			push("K1", "流式思考与产出（分区/增量/首字/失败态/重试）",
				"真实启动一次优化并采样两栏字数；再用未注册 provider 触发真实失败并点重试",
				"两栏独立且不混、字数持续增长、首字 ≤2s（不白屏）、失败有可读原因+重试且产出栏为空、重试后恢复出字",
				{
					firstPaintMs: kFirst, panesEarly: { reasoning: kPaneREarly, text: kPaneTEarly },
					snap1: kSnap1, snap2: kSnap2, separated: kSeparated,
					runStatus: kRun.status, textChars: kText.length, reasoningChars: kReason.length,
					fail: kFail, recovered: kRecovered,
				}, k1pass);
			// L1：审查态与双按钮（可编辑 / 超长可滚 / 同色系 / 红色 / 提交链路）
			const lArea0 = document.querySelector('[data-dpo="review-text"]');
			const lConfirm = document.querySelector('[data-dpo="confirm"]');
			const lRegen = document.querySelector('[data-dpo="regen"]');
			const lLong = "DPO-编辑后-" + "段落内容".repeat(140);
			if (lArea0) {
				const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
				setter.call(lArea0, lLong);
				lArea0.dispatchEvent(new Event("input", { bubbles: true }));
			}
			await frame();
			await sleep(150);
			const lArea = document.querySelector('[data-dpo="review-text"]');
			const lEdited = Boolean(store.reviewText === lLong);
			const lScroll = lArea ? { scrollH: lArea.scrollHeight, clientH: lArea.clientHeight, overflowY: getComputedStyle(lArea).overflowY } : null;
			const lScrollable = Boolean(lScroll) && lScroll.scrollH > lScroll.clientH && (lScroll.overflowY === "auto" || lScroll.overflowY === "scroll");
			const rgbOf = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(s || "")); return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null; };
			const lSendBtn = sendButtonOf(cardOf(store.node));
			const lSendBg = lSendBtn ? getComputedStyle(lSendBtn).backgroundColor : null;
			const lConfirmBg = lConfirm ? getComputedStyle(lConfirm).backgroundColor : null;
			const lRegenBg = lRegen ? getComputedStyle(lRegen).backgroundColor : null;
			const lRegenRgb = rgbOf(lRegenBg);
			const lRegenIsRed = Boolean(lRegenRgb) && lRegenRgb.r > 140 && lRegenRgb.g < 120 && lRegenRgb.b < 120;
			const lSameAccent = Boolean(lSendBg && lConfirmBg && lSendBg === lConfirmBg);
			const lDraftBefore = draftLive();
			try { await post("/watch/clear", {}); } catch (e) { /* noop（清看门狗以便观测本条，收尾 sweep 会重新挂回） */ }
			const lRunning = runningNow();
			if (lConfirm && lRunning) dispatchClick(lConfirm, "l1confirm");
			if (!lRunning) { push("L1", "审查态与双按钮", "会话 idle：跳过破坏性提交（避免消息永久落库）", "仅验证可编辑/可滚/配色", { skippedSubmit: true, edited: lEdited, scrollable: lScrollable, sameAccent: lSameAccent, regenIsRed: lRegenIsRed }, lEdited && lScrollable && lSameAccent && lRegenIsRed); }
			await frame();
			await sleep(350);
			const lDraftAfter = draftLive();
			let lQueuedRow = null;
			for (let i = 0; i < 14 && !lQueuedRow; i += 1) {
				await sleep(300);
				lQueuedRow = (sessionOf().queue || []).find((r) => String(r.text || "").includes("DPO-编辑后-")) || null;
			}
			let lRemoved = null;
			try { lRemoved = await post("/queued/remove-by-text", { match: "DPO-编辑后-" }); } catch (e) { lRemoved = { error: String(e) }; }
			const lRemovedCount = lRemoved && Array.isArray(lRemoved.removed) ? lRemoved.removed.length : 0;
			const lReviewGone = !document.querySelector('[data-dpo="review"]');
			const l1pass = Boolean(lArea0 && lConfirm && lRegen) && lEdited && lScrollable && lRegenIsRed && lSameAccent
				&& lDraftAfter === "" && lRemovedCount > 0 && lReviewGone;
			push("L1", "审查态与双按钮（可编辑/可滚/配色/提交链路）",
				"写入超长编辑文本→派发 input；取官方发送按钮与『确认提交』计算色；点确认提交→查输入框与官方待处理队列→宿主撤销",
				"编辑值被采纳、超长可滚、确认提交与发送按钮同色、重新生成为红、提交后输入框清空且文本进入官方队列（零污染）",
				{
					hasTextarea: Boolean(lArea0), hasConfirm: Boolean(lConfirm), hasRegen: Boolean(lRegen),
					edited: lEdited, scroll: lScroll, scrollable: lScrollable,
					sendBg: lSendBg, confirmBg: lConfirmBg, sameAccent: lSameAccent,
					regenBg: lRegenBg, regenIsRed: lRegenIsRed,
					draftBeforeLen: String(lDraftBefore || "").length, draftAfterLen: String(lDraftAfter || "").length,
					queuedRow: Boolean(lQueuedRow), queuedText: lQueuedRow ? String(lQueuedRow.text).slice(0, 40) : null,
					removedCount: lRemovedCount, reviewClosed: lReviewGone,
				}, l1pass);
			// M1：回退二次确认（确认行 / 取消不丢状态 / 确定=停+关+不发+原文保持 / 无残留 / 不串台）
			const mOrig = "DPO-原文保持-" + token;
			if (actions) actions.setDraft(mOrig);
			await frame();
			startRun("把那个页面弄好看点，动画也加上", "basic", false);
			for (let i = 0; i < 60 && (store.run.status === "connecting" || (store.run.text || "").length === 0 && (store.run.reasoning || "").length === 0); i += 1) await sleep(200);
			const mRunningBefore = store.run ? store.run.status : null;
			const mRbBtn = document.querySelector('[data-dpo="rollback"]');
			if (mRbBtn) dispatchClick(mRbBtn, "m1rb");
			await frame();
			await sleep(120);
			const mConfirmShown = Boolean(document.querySelector('[data-dpo="rollback-confirm"]'));
			const mStateKeptOnPrompt = store.run ? store.run.status : null;
			const mNoBtn = document.querySelector('[data-dpo="rollback-no"]');
			if (mNoBtn) dispatchClick(mNoBtn, "m1no");
			await frame();
			await sleep(120);
			const mConfirmGone = !document.querySelector('[data-dpo="rollback-confirm"]');
			const mStateKeptAfterCancel = store.run ? store.run.status : null;
			// 再点回退 → 确定
			const mRbBtn2 = document.querySelector('[data-dpo="rollback"]');
			if (mRbBtn2) dispatchClick(mRbBtn2, "m1rb2");
			await frame();
			await sleep(120);
			const mYesBtn = document.querySelector('[data-dpo="rollback-yes"]');
			const mRunIdBefore = store.run ? store.run.runId : null;
			if (mYesBtn) dispatchClick(mYesBtn, "m1yes");
			await frame();
			await sleep(800);
			const mOverlayGone = !document.querySelector('[data-dpo="overlay"]');
			const mRunCleared = store.run === null;
			const mDraftKept = draftLive() === mOrig;
			let mRuns = null;
			try { mRuns = await (await fetch(API + "/runs", { cache: "no-store" })).json(); } catch (e) { mRuns = { error: String(e) }; }
			const mTarget = mRuns && Array.isArray(mRuns.runs) ? mRuns.runs.find((r) => r.id === mRunIdBefore) : null;
			const mNoResidue = Boolean(mTarget) && mTarget.status === "aborted" && mTarget.subs === 0;
			// 不串台：回退后再起一次，应能正常跑完
			startRun("把那个页面弄好看点", "basic", false);
			for (let i = 0; i < 160 && store.run && store.run.status !== "done" && store.run.status !== "error"; i += 1) await sleep(250);
			const mNextOk = Boolean(store.run) && store.run.status === "done" && (store.run.text || "").length > 0;
			const m1pass = Boolean(mRbBtn && mYesBtn) && mConfirmShown && mStateKeptOnPrompt === mRunningBefore
				&& mConfirmGone && (mStateKeptAfterCancel === "running" || mStateKeptAfterCancel === mRunningBefore)
				&& mOverlayGone && mRunCleared && mDraftKept && mNoResidue && mNextOk;
			push("M1", "回退二次确认（确认/取消/中止/原文保持/不串台）",
				"起一次优化→点回退看确认行→取消（状态应不丢）→再点回退并确定→查宿主 /runs 与输入框→再起一次验证不串台",
				"确认行出现、取消后状态不丢、确定后浮层关闭+run 中止且 subs=0+原文逐字保持+不发消息、随后再次优化能正常完成",
				{
					runningBefore: mRunningBefore, confirmShown: mConfirmShown, stateKeptOnPrompt: mStateKeptOnPrompt,
					confirmGoneAfterCancel: mConfirmGone, stateAfterCancel: mStateKeptAfterCancel,
					overlayClosed: mOverlayGone, runCleared: mRunCleared, draftKept: mDraftKept,
					abortedRun: mTarget, noResidue: mNoResidue, nextRunOk: mNextOk,
					nextRunChars: store.run ? (store.run.text || "").length : 0,
				}, m1pass);
			store.rollbackConfirm = false;
			setOverlay({ open: false });
			store.run = null;
			if (actions) actions.setDraft("");
			// N1：优化模型弹层（同源目录 / 独立于对话模型 / 下一次优化生效）
			let nCat = null;
			try { nCat = await (await fetch(API + "/models", { cache: "no-store" })).json(); } catch (e) { nCat = { error: String(e) }; }
			store.modelCatalog = nCat && nCat.ok ? nCat : null;
			const nCard = cardOf(store.node);
			const nSeat = buttonsOf(nCard).find((b) => String(b.getAttribute("aria-label")).includes("选择模型"));
			const nSeatBefore = nSeat ? nSeat.getAttribute("aria-label") : null;
			const nGroups = nCat && Array.isArray(nCat.groups) ? nCat.groups : [];
			const nSeatName = nSeatBefore ? (nSeatBefore.match(/当前\s*([^，,]+)/) || [])[1] : null;
			const nNameMatched = Boolean(nSeatName) && nGroups.some((g) => (g.models || []).some((m) => m.name === nSeatName || m.id === nSeatName));
			const nPill = nCard ? nCard.querySelector('[data-dpo="model"]') : null;
			if (nPill) dispatchClick(nPill, "n1open");
			await frame();
			await sleep(180);
			const nPop = document.querySelector('[data-dpo="model-pop"]');
			const nItems = [...document.querySelectorAll('[data-dpo="model-item"]')];
			const nTitles = [...document.querySelectorAll('[data-dpo="model-group-name"]')].map((el) => String(el.textContent));
			const curSel = nCat && nCat.current ? nCat.current : null;
			let nPick = null;
			for (const el of nItems) {
				const p = el.getAttribute("data-provider");
				const m = el.getAttribute("data-model");
				if (!curSel || p !== curSel.provider || m !== curSel.model) { nPick = { provider: p, model: m, name: String(el.textContent) }; break; }
			}
			if (nPick) {
				const target = nItems.find((el) => el.getAttribute("data-provider") === nPick.provider && el.getAttribute("data-model") === nPick.model);
				if (target) dispatchClick(target, "n1pick");
			}
			await frame();
			await sleep(180);
			const nSel = store.modelSel;
			const nSeatAfter = nSeat ? nSeat.getAttribute("aria-label") : null;
			const nPopClosed = !document.querySelector('[data-dpo="model-pop"]');
			let nRunSel = null;
			if (nSel) {
				startRun("把那个页面弄好看点", "basic", false);
				for (let i = 0; i < 40 && !(store.run && store.run.runId); i += 1) await sleep(200);
				await sleep(1200);
				try {
					const rr = await (await fetch(API + "/runs", { cache: "no-store" })).json();
					const mine = rr && Array.isArray(rr.runs) ? rr.runs.find((x) => x.id === (store.run ? store.run.runId : null)) : null;
					nRunSel = mine ? { provider: mine.provider, model: mine.model } : null;
				} catch (e) { nRunSel = { error: String(e) }; }
				if (store.run && store.run.runId) { try { await post("/run/abort", { runId: store.run.runId }); } catch (e) { /* noop */ } }
				store.run = null;
				setOverlay({ open: false });
			}
			const n1pass = Boolean(nPop) && nItems.length > 0 && nGroups.length > 0 && nNameMatched
				&& nTitles.length === nGroups.length && Boolean(nSel) && nSeatAfter === nSeatBefore && nPopClosed
				&& Boolean(nRunSel) && nRunSel.provider === nSel.provider && nRunSel.model === nSel.model;
			push("N1", "优化模型弹层（同源/独立/生效）",
				"拉 /models 与官方座位 aria-label 交叉核对；点胶囊开弹层→选一个不同的模型→查官方座位是否变→再跑一次优化查 /runs 实际模型",
				"弹层分组数=目录分组数且模型名与官方座位同源；选择只影响优化（官方座位 aria-label 一字不变）；下一次运行 provider/model == 新选择",
				{
					catalogGroups: nGroups.length, catalogModels: nGroups.reduce((a, g) => a + (g.models || []).length, 0),
					seatLabelBefore: nSeatBefore, seatModelName: nSeatName, nameMatched: nNameMatched,
					popShown: Boolean(nPop), items: nItems.length, groupTitles: nTitles.slice(0, 4),
					picked: nPick, selection: nSel, seatLabelAfter: nSeatAfter, seatUnchanged: nSeatAfter === nSeatBefore,
					popClosed: nPopClosed, runUsed: nRunSel,
				}, n1pass);
			store.modelSel = null;
			emit();
			// P1：落盘与兜底（不可用模型提示 / 一键回默认 / 双客户端一致）
			const pA = await (await fetch(API + "/state", { cache: "no-store" })).json();
			const pB = await (await fetch(API + "/state", { cache: "no-store" })).json();
			const pConsistent = JSON.stringify(pA.state) === JSON.stringify(pB.state);
			store.modelSel = { provider: "ollama", model: "qwen3:8b", name: "qwen3:8b（本地）" };
			persistState();
			startRun("落盘兜底测试：把那个页面弄好看点", "basic", false);
			for (let i = 0; i < 100 && store.run && store.run.status !== "error" && store.run.status !== "done"; i += 1) await sleep(250);
			await frame();
			await sleep(150);
			const pErr = document.querySelector('[data-dpo="run-error"]');
			const pReset = document.querySelector('[data-dpo="reset-model"]');
			const pFail = { status: store.run ? store.run.status : null, msg: pErr ? String(pErr.textContent).slice(0, 110) : null, hasReset: Boolean(pReset) };
			let pRecovered = false;
			if (pReset) {
				dispatchClick(pReset, "p1reset");
				for (let i = 0; i < 140 && store.run && (store.run.status === "running" || store.run.status === "connecting"); i += 1) await sleep(250);
				pRecovered = Boolean(store.run) && store.run.status === "done" && (store.run.text || "").length > 0 && !store.modelSel;
			}
			const pAfter = await (await fetch(API + "/state", { cache: "no-store" })).json();
			if (store.run && store.run.runId) { try { await post("/run/abort", { runId: store.run.runId }); } catch (e) { /* noop */ } }
			const p1pass = pConsistent && pFail.status === "error" && Boolean(pFail.msg) && pFail.hasReset
				&& pRecovered === true && pAfter.state.model === null;
			push("P1", "落盘与兜底（提示/一键回默认/一致性）",
				"选一个真实不可用的模型（ollama 本机未启动）起跑→看错误提示与恢复按钮→点『恢复默认模型并重试』→查是否用回默认且落盘清空；并两次读 /state 比对",
				"失败有可读原因、有『恢复默认』入口、点击后回到默认模型并成功出字、落盘 model=null、两次读取一致",
				{
					consistent: pConsistent, before: { tier: pA.state.tier, permission: pA.state.permission, model: pA.state.model }, fail: pFail,
					recovered: pRecovered, after: { tier: pAfter.state.tier, permission: pAfter.state.permission, model: pAfter.state.model, revision: pAfter.state.revision },
					finalChars: store.run ? (store.run.text || "").length : 0,
				}, p1pass);
			store.run = null;
			setOverlay({ open: false });
			// H1：真·A/B 基线 —— 拆净本插件全部监听后，同一手势应原样进入官方链路
			const baselineMarker = "DPO-基线测试-" + token;
			const h1BeforeQueue = (sessionOf().queue || []).length;
			let h1Baseline = { executed: false };
			let h1Removed = null;
			let h1Restored = false;
			try {
				if (typeof window.__DPO_DISPOSE__ === "function") window.__DPO_DISPOSE__();
				await sleep(250);
				if (actions) actions.setDraft(baselineMarker);
				await frame();
				if (editor) editor.focus();
				// H1 基线用"当前页面上的活编辑器"重新解析（拆净插件后旧引用可能已脱离文档）
				const liveEditor = document.querySelector('[contenteditable="true"]');
				if (liveEditor) liveEditor.focus();
				const h1CountBefore = store.intercepts.length;
				dispatchKey(liveEditor || editor, {}, "h1");
				let h1Row = null;
				for (let i = 0; i < 12 && h1Row === null; i += 1) {
					await sleep(300);
					h1Row = (sessionOf().queue || []).find((r) => String(r.text || "").includes(baselineMarker)) || null;
				}
				h1Baseline = {
					executed: true,
					interceptedWhileDisposed: store.intercepts.length > h1CountBefore,
					queueBefore: h1BeforeQueue,
					queuedRow: Boolean(h1Row),
					queuedText: h1Row ? String(h1Row.text).slice(0, 50) : null,
					controlsNodeGone: !(store.node && store.node.isConnected),
				};
				try { h1Removed = await post("/queued/remove-by-text", { match: baselineMarker }); } catch (e) { h1Removed = { error: String(e) }; }
			} catch (e) {
				h1Baseline = { executed: false, error: String(e) };
			} finally {
				try { exports.apply(ctx); } catch (e) { /* 恢复失败在下一步断言里体现 */ }
				await sleep(400);
				const back = cardOf(store.node);
				h1Restored = Boolean(back && back.querySelector('[data-dpo="tier"]'));
			}
			push("H1", "真·A/B 基线（插件拆净）",
				"调用自身 dispose 移除全部监听与 UI → 派发同一 Enter → 宿主权威核对官方队列 → 撤销 → 重新装载",
				"无监听时同一手势原样进入官方待处理队列；撤销成功；重新装载后三控件回到原位",
				{
					baseline: h1Baseline, removed: h1Removed, restored: h1Restored,
					removedCount: h1Removed && Array.isArray(h1Removed.removed) ? h1Removed.removed.length : 0,
					note: "拆净后客户端快照不再刷新，故以宿主权威撤销结果为准（queuedRow 字段仅作参考）",
				},
				h1Baseline.interceptedWhileDisposed === false
					&& Boolean(h1Removed && Array.isArray(h1Removed.removed) && h1Removed.removed.length > 0)
					&& h1Restored === true);

			const windowEnd = Date.now();
			// 自清场：把本探针可能在官方队列里留下的标记项全部撤掉（宿主侧权威扫描）
			let sweep = null;
			try { sweep = await post("/inbox/sweep", {}); } catch (e) { sweep = { error: String(e) }; }
			if (actions) {
				if (actions) actions.setDraft(initialDraft || "");
				await frame();
			}
			const report = {
				plugin: NS, token, kind: "selftest",
				sessionId: String(store.latest.sessionId || ""),
				windowStart, windowEnd,
				userAgent: String(navigator.userAgent || ""),
				env: { sendLabels: [...SEND_LABELS], interceptCount: store.intercepts.length, intercepts: store.intercepts.slice(-8) },
				steps,
				sweep,
				passed: steps.filter((s) => s.pass).length,
				total: steps.length,
			};
			releaseProbeArtifacts();
			// 收尾还原用户配置（档位/权限/浮层几何）——探针绝不能留下"档位被关掉"这类副作用
			const snap = store.probeUiSnapshot;
			if (snap) {
				if (snap.tier && snap.tier !== store.tier) setTier(snap.tier, "probe-restore");
				if (snap.permission && snap.permission !== store.permission) setPermission(snap.permission, "probe-restore");
				store.overlaySize = snap.size || null;
				store.overlayPos = snap.pos || null;
				setOverlay({ open: false });
				beacon("probe-restored", { tier: store.tier, permission: store.permission, size: store.overlaySize });
			}
			window.__DPO_PROBE_RUNNING__ = false;
			const res = await post("/report", report);
			store.lastReport = { ok: Boolean(res && res.ok), file: res && res.file, userMessageCount: res && res.userMessageCount };
			emit();
			return report;
		}

		/* ══════════ 插件体 ══════════ */
		exports.inject = ["slots", "locale"];

		exports.apply = function apply(ctx) {
			// HMR/重复 apply：新实例接管前先拆掉旧实例全部副作用（防双轮询 → 双探针 → 队列残留）
			const previousToken = (() => { try { return window.__DPO_ACTIVE__ || null; } catch (e) { return null; } })();
			try { if (typeof window.__DPO_DISPOSE__ === "function") window.__DPO_DISPOSE__(); } catch (e) { /* noop */ }
			// 抢注单例 token：此后旧实例的拦截与渲染一律作废（旧实例"后台跑、无 UI"的根因）
			try { window.__DPO_ACTIVE__ = INSTANCE_TOKEN; } catch (e) { /* noop */ }
			const ownDisposers = [];
			const own = (register, label) => {
				const dispose = ctx.effect(register, label);
				ownDisposers.push(typeof dispose === "function" ? dispose : () => {});
			};
			window.__DPO_DISPOSE__ = () => {
				for (const d of ownDisposers) { try { d(); } catch (e) { /* noop */ } }
				ownDisposers.length = 0;
				window.__DPO_PROBE_RUNNING__ = false;
			};
			localeService = ctx.locale;
			if (localeService && typeof localeService.subscribe === "function") {
				own(() => localeService.subscribe(() => { loadSendLabels(); beacon("labels", { labels: [...SEND_LABELS] }); }), NS + ": locale watch");
			}
			const labels = loadSendLabels();
			ctx.logger?.info?.("[" + NS + "] send labels = " + JSON.stringify(labels));
			fetch(API + "/state", { cache: "no-store" }).then((r) => r.json()).then((d) => {
				const st = d && d.ok ? d.state : null;
				if (!st) return;
				// 上下文设置（上游 0.1.9）：回合数 / 模式 / 全文开关
				if (typeof st.turns === "number") store.turns = Math.max(0, Math.min(TURNS_MAX, Math.round(st.turns)));
				if (st.historyMode === "turns" || st.historyMode === "full") store.historyMode = st.historyMode;
				store.fullOn = st.fullOn === true;
				// 注：旧的浮窗几何（尺寸/位置）已随浮窗一起废弃，这里不再恢复。
				// 按会话的档位/权限：先装入表（无论用户是否刚改过，都要装上）
				if (st.perSession && typeof st.perSession === "object") {
					for (const k of Object.keys(st.perSession)) {
						const v = st.perSession[k] || {};
						if (typeof v.tier === "string") store.tierBySession[k] = v.tier;
						if (typeof v.permission === "string") store.permissionBySession[k] = v.permission;
					}
					beacon("per-session-restored", { sessions: Object.keys(st.perSession).length, current: store.viewSessionId || null });
				}
				// 若用户在请求返回前已手动改过档位/权限，绝不让迟到的落盘值回写覆盖
				if (store.touched === true) { beacon("state-skip-stale", { tier: store.tier, permission: store.permission }); emit(); return; }
				if (st.tier && st.tier !== store.tier) setTier(st.tier, "init");
				if (st.permission && st.permission !== store.permission) setPermission(st.permission, "init");
				// 表里有当前会话的值 → 以它为准（覆盖全局默认）
				applyTierPermissionFor(store.viewSessionId);
				store.modelSel = st.model ? { provider: st.model.provider, model: st.model.model, name: st.model.name || st.model.model } : null;
				beacon("state-loaded", { tier: store.tier, permission: store.permission, model: st.model ? st.model.provider + "/" + st.model.model : null, revision: st.revision, perSessionHit: Boolean(st.perSession && st.perSession[store.viewSessionId || ""]) });
				emit();
			}).catch(() => {});
			beacon("apply", { build: "v56-dock", token: INSTANCE_TOKEN, previousToken, hasBoundary: String(DockBoundary).indexOf("getDerivedStateFromError") >= 0, layout: "composer-dock" });
			// 目录预热：开弹层时无需等待（首次打开即已是本地数据）
			window.setTimeout(() => { try { if (isActiveInstance()) void loadCatalog("apply", false); } catch (e) { /* noop */ } }, 600);
			// 样式落地自检：读真实注入的样式表，确认"更大默认尺寸 + 内层滚动 + 改尺寸手柄"确实生效
			window.setTimeout(() => {
				try {
					const rules = [];
					for (const sheet of Array.from(document.styleSheets)) {
						try { for (const r of Array.from(sheet.cssRules || [])) rules.push(r.cssText || ""); } catch (e) { /* 跨域表 */ }
					}
					const blob = rules.join("\n").replace(/\s+/g, ""); // 浏览器会规范化 cssText（冒号后补空格），去空白后比较
					const has = (needle) => blob.indexOf(needle) >= 0;
					beacon("css-probe", {
						rules: rules.length,
						bigger: has("max-height:min(78vh,660px)") && has("width:520px"),
						innerScroll: has(".dpo-overlay-scroll") && has("flex:11auto"),
						overflowY: has("overflow-y:auto"),
						grip: has(".dpo-size-grip") && has("cursor:nwse-resize"),
						stickyReview: has(".dpo-review.dpo-overlay-actions") && has("bottom:0"),
						regenStyles: has(".dpo-regen-input"),
						// v51 精致化视觉层
						polish: has("@keyframesdpo-pop-in") && has("@keyframesdpo-ov-rise") && has("@keyframesdpo-pulse") && has("@keyframesdpo-tick") && has("@keyframesdpo-shimmer"),
						glass: has("backdrop-filter:blur(16px)"),
						accMix: has("--dpo-acc:var(--dsw-alias-state-business-primary"),
						stateDot: has(".dpo-overlay[data-state=\"running\"]"),
						liveCaret: has(".dpo-pane[data-live=\"true\"]"),
						selHighlight: has(".dpo-pop-item[data-selected=\"true\"]"),
						reduceMotion: has("prefers-reduced-motion:reduce"),
						// v52 舒适层
						comfort: has("flex:01148px") && has("min-width:124px") && has("--dpo-fs-2:13px") && has("width:308px") && has("max-height:132px") && has("min-height:150px"),
					});
				} catch (e) { beacon("css-probe", { error: String(e) }); }
			}, 400);

			// 捕获阶段拦截：注册在 window 上，早于 React 根容器与编辑器自身处理器
			own(() => {
				let staleBeacons = 0;
				const stale = (how) => {
					if (staleBeacons < 3) { staleBeacons += 1; beacon("stale-instance-ignored", { how, token: INSTANCE_TOKEN, active: String(window.__DPO_ACTIVE__ || "").slice(-12) }); }
					return true;
				};
				const onFocus = (e) => {
					const card = cardOf(store.node);
					lastFocusInComposer = Boolean(card && e.target && card.contains(e.target));
				};
				const onKey = (e) => {
					if (!isActiveInstance()) return stale("keydown");
					if (e.key !== "Enter") {
						const now = Date.now();
						if (now - lastKeyBeacon > 800) {
							lastKeyBeacon = now;
							beacon("keydown-any", {
								key: e.key, trusted: e.isTrusted === true,
								draftHookLen: draftFromHook().length,
								draftDomLen: draftFromDom() === null ? null : draftFromDom().length,
								inside: insideComposer(),
							});
						}
						return;
					}
					const verdict = interceptKey(e);
					beacon("keydown-enter", {
						verdict,
						trusted: e.isTrusted === true,
						isComposing: e.isComposing === true,
						keyCode: e.keyCode,
						shift: e.shiftKey,
						armed: store.armed,
						card: Boolean(cardOf(store.node)),
						inside: insideComposer(),
						lastFocusInComposer,
						activeTag: document.activeElement ? document.activeElement.tagName : null,
						activeCE: document.activeElement ? document.activeElement.isContentEditable === true : null,
						draftLen: draftLive().length,
						draftHookLen: draftFromHook().length,
						draftDomLen: draftFromDom() === null ? null : draftFromDom().length,
					});
					if (!verdict) return;
					e.preventDefault();
					e.stopPropagation();
					const row = record("keydown-enter", draftLive());
					interceptAndOptimize(row.text);
				};
				const onClick = (e) => {
					if (!isActiveInstance()) return stale("click");
					const btn = e.target && e.target.closest ? e.target.closest("button") : null;
					if (!btn) return;
					const card = cardOf(store.node);
					if (!card || !card.contains(btn)) return;
					const verdict = interceptClick(e);
					const label = btn.getAttribute("aria-label");
					beacon("click-button", {
						verdict, label, isLast: lastButtonOf(card) === btn,
						byLabel: isSendLabel(label), labels: [...SEND_LABELS], armed: store.armed,
					});
					if (!verdict) return;
					e.preventDefault();
					e.stopPropagation();
					const row = record("click-send", draftLive(), { label });
					interceptAndOptimize(row.text);
				};
				document.addEventListener("focusin", onFocus, true);
				document.addEventListener("focusout", onFocus, true);
				window.addEventListener("keydown", onKey, true);
				window.addEventListener("click", onClick, true);
				return () => {
					document.removeEventListener("focusin", onFocus, true);
					document.removeEventListener("focusout", onFocus, true);
					window.removeEventListener("keydown", onKey, true);
					window.removeEventListener("click", onClick, true);
				};
			}, NS + ": capture listeners");

			// 样式（随插件卸载移除）
			own(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", NS);
				style.textContent = [
					".dpo-anchor{display:none}",
					/* 与同排的「工作区内修改」「模型」保持一致的次级文字色，hover 才提亮 */
					".dpo-chip{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:min(100%,220px);min-height:28px;padding:0 8px;border:none;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary,#aaa);font-family:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}",
					".dpo-chip:hover,.dpo-chip[aria-expanded=\"true\"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#eee)}",
					".dpo-chip[data-off=\"true\"]{color:var(--dsw-alias-label-tertiary,#999)}",
					".dpo-chip-icon{flex:none;opacity:.85}",
					".dpo-chip[data-off=\"true\"] .dpo-chip-icon{opacity:.45}",
					".dpo-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
					".dpo-chip-chevron{flex:none;color:var(--dsw-alias-label-caption,#888)}",
					".dpo-row{display:flex;align-items:baseline;gap:8px;min-width:0}",
					".dpo-row-name{flex:none}",
					".dpo-row-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-caption,#888);font-size:12px}",
					/* ══════════ 上下文控件：塞在菜单的一个 label 项里（label 是 div，不是按钮） ══════════ */
					".dpo-ctx{display:flex;align-items:center;gap:8px;min-width:0;width:100%;padding:2px 0}",
					".dpo-ctx-label{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}",
					".dpo-ctx-track{position:relative;flex:1 1 auto;min-width:54px;height:18px;display:flex;align-items:center;cursor:pointer;touch-action:none}",
					".dpo-ctx-track::before{content:\"\";position:absolute;left:0;right:0;top:8px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l1,#3a3a3a)}",
					".dpo-ctx-fill{position:absolute;left:0;top:8px;height:3px;border-radius:2px;background:var(--dsw-alias-state-business-primary,#4a9eff);pointer-events:none;transition:width .16s ease}",
					".dpo-ctx-thumb{position:absolute;top:3px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4a9eff);pointer-events:none;transition:left .16s ease,transform .14s ease}",
					".dpo-ctx-track:hover .dpo-ctx-thumb{transform:scale(1.12)}",
					".dpo-ctx-track:focus-visible{outline:none}",
					".dpo-ctx-track:focus-visible .dpo-ctx-thumb{box-shadow:0 0 0 3px var(--dpo-acc-22)}",
					".dpo-ctx-track[data-full=\"true\"] .dpo-ctx-fill{opacity:.45}",
					".dpo-ctx-track[data-full=\"true\"] .dpo-ctx-thumb{opacity:.45}",
					".dpo-ctx-value{flex:none;min-width:46px;text-align:right;color:var(--dsw-alias-label-secondary,#ccc);font-size:12px;white-space:nowrap}",
					".dpo-ctx-full{flex:none;height:20px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:0 0;color:var(--dsw-alias-label-tertiary,#999);font-family:inherit;font-size:11px;line-height:18px;cursor:pointer}",
					".dpo-ctx-full:hover{border-color:var(--dsw-alias-state-business-primary,#4a9eff);color:var(--dsw-alias-state-business-primary,#4a9eff)}",
					".dpo-ctx-full[data-on=\"true\"]{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4a9eff);color:#fff}",
					/* 收藏夹面板：作为右侧栏的一个 tab，列表自己滚动，外壳交给侧栏 */
					".dpo-fav-pane{overflow:hidden}",
					".dpo-fav-bar{flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px 10px}",
					".dpo-fav-head{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#eee);font-size:13px;font-weight:600}",
					".dpo-fav-count{flex:none;color:var(--dsw-alias-label-caption,#888);font-size:11px}",
					".dpo-fav-close{flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;transition:background .16s,color .16s}",
					".dpo-fav-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#eee)}",
					".dpo-fav-search{flex:none;box-sizing:border-box;width:calc(100% - 28px);height:28px;margin:0 14px 8px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:0 0;color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:12px}",
					".dpo-fav-search:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4a9eff);box-shadow:0 0 0 3px var(--dpo-acc-12)}",
					".dpo-fav-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:0 10px 8px}",
					".dpo-fav-row{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:9px;transition:background .16s}",
					".dpo-fav-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
					".dpo-fav-row[data-pinned=\"true\"]{background:var(--dpo-acc-12)}",
					".dpo-fav-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;padding:0;border:none;background:0 0;text-align:left;cursor:pointer;color:inherit;font-family:inherit}",
					".dpo-fav-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#eee);font-size:12.5px}",
					".dpo-fav-meta{color:var(--dsw-alias-label-caption,#888);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
					".dpo-fav-acts{flex:none;display:flex;align-items:center;gap:4px}",
					".dpo-fav-btn{height:22px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:0 0;color:var(--dsw-alias-label-secondary,#ccc);font-family:inherit;font-size:11px;line-height:20px;white-space:nowrap;cursor:pointer;transition:border-color .16s,color .16s,background .16s}",
					".dpo-fav-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4a9eff);color:var(--dsw-alias-state-business-primary,#4a9eff)}",
					".dpo-fav-btn:disabled{opacity:.4;cursor:not-allowed}",
					".dpo-fav-btn[data-on=\"true\"]{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4a9eff);color:#fff}",
					".dpo-fav-btn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#f2777a);color:var(--dsw-alias-state-error-primary,#f2777a)}",
					".dpo-fav-edit{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
					".dpo-fav-input{box-sizing:border-box;width:100%;height:26px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:0 0;color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:12px}",
					".dpo-fav-textarea{box-sizing:border-box;width:100%;min-height:88px;max-height:240px;padding:7px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:0 0;color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:12px;line-height:1.55;resize:vertical}",
					".dpo-fav-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4a9eff);box-shadow:0 0 0 3px var(--dpo-acc-12)}",
					".dpo-fav-editacts{display:flex;align-items:center;gap:6px}",
					".dpo-fav-hint{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-caption,#888);font-size:11px}",
					".dpo-fav-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4a9eff);box-shadow:0 0 0 3px var(--dpo-acc-12)}",
					".dpo-fav-empty{flex:none;padding:18px 4px;color:var(--dsw-alias-label-caption,#888);font-size:12px;text-align:center}",
					".dpo-fav-foot{flex:none;display:flex;align-items:center;gap:6px;padding:10px 14px 12px;border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1,#333))}",
					".dpo-fav-confirmtext{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,#ccc);font-size:12px}",
					".dpo-fav-foot .dpo-btn{flex:none}",
					".dpo-fav-file{display:none}",
					".dpo-notice{flex:0 0 auto;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#ccc);font-size:12px;white-space:nowrap}",
					".dpo-help-panel{position:fixed;z-index:1100;box-sizing:border-box;width:340px;max-height:min(70vh,520px);overflow-y:auto;padding:14px 16px;border:0;border-radius:20px;background:var(--dsw-specific-menu,var(--dsw-specific-tip,#1b1b1b));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.6}",
					/* 标题栏：左上角一枚小返回键（回到设置菜单），右边是标题 */
					".dpo-help-bar{display:flex;align-items:center;gap:8px;padding-bottom:8px}",
					".dpo-back{display:inline-flex;align-items:center;gap:2px;height:22px;padding:0 8px 0 5px;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary,#999);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}",
					".dpo-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#eee)}",
					".dpo-help-head{color:var(--dsw-alias-label-primary,#eee);font-size:13px;font-weight:500}",
					".dpo-help-sec{display:flex;align-items:center;gap:8px;margin:12px 0 6px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}",
					".dpo-help-sec::after{content:\"\";flex:1 1 auto;height:1px;background:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1,#333))}",
					".dpo-help-sec:first-of-type{margin-top:2px}",
					".dpo-help-row{display:flex;gap:10px;padding:3px 0;font-size:12px;line-height:1.6}",
					".dpo-help-k{flex:0 0 62px;color:var(--dsw-alias-label-primary,#eee);font-weight:500}",
					".dpo-help-v{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,#c9c9c9)}",
					".dpo-help-tip{margin-top:13px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.6;font-weight:600}",
					".dpo-help-meta{margin-top:12px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1,#333));color:var(--dsw-alias-label-caption,#888);font-size:11px;text-align:center;letter-spacing:.2px}",
					/* ══════════ 右侧栏里的优化面板 ══════════ */
					".dpo-pane{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;overflow-y:auto;color:var(--dsw-alias-label-primary,#eee);font-size:13px}",
					".dpo-pane-status{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#333)}",
					".dpo-pane-empty{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;height:100%;padding:24px;color:var(--dsw-alias-label-caption,#888);font-size:13px;text-align:center}",
					".dpo-pane-empty-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.6}",
					".dpo-pane-title{display:inline-flex;align-items:center;gap:6px}",
					".dpo-pane-title[data-state=\"running\"]::before{content:\"\";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4a9eff);animation:dpo-pulse 1.6s ease-out infinite}",
					".dpo-pane-title[data-state=\"done\"]::before{content:\"\";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#3ecf8e)}",
					".dpo-pane-title[data-state=\"error\"]::before{content:\"\";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#f2777a)}",
					".dpo-pane .dpo-dock-body{padding:10px 12px 0}",
					".dpo-pane .dpo-dock-foot{padding:10px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1,#333);flex-wrap:wrap}",
					/* 侧栏比输入框宽得多，产出框跟着放宽 */
					".dpo-pane .dpo-out{max-height:min(60vh,620px)}",
					".dpo-dock{box-sizing:border-box;display:flex;flex-direction:column;flex:none;margin:0 auto;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,760px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));border:.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:12px;background:var(--dsw-specific-tip,#1b1b1b);color:var(--dsw-alias-label-primary,#eee);font-size:13px;overflow:hidden}",
					".dpo-dock-head{display:flex;align-items:center;gap:10px;width:100%;padding:8px 12px;border:none;background:0 0;text-align:left;cursor:pointer;color:inherit;font-family:inherit;font-size:13px;line-height:20px}",
					".dpo-dock-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
					".dpo-dock-lead{flex:none;display:grid;place-items:center;border-radius:50%;color:var(--dsw-alias-label-tertiary,#999)}",
					".dpo-dock[data-state=\"running\"] .dpo-dock-lead{color:var(--dsw-alias-state-business-primary,#4a9eff);animation:dpo-pulse 1.6s ease-out infinite}",
					".dpo-dock[data-state=\"done\"] .dpo-dock-lead{color:var(--dsw-alias-state-success-primary,#3ecf8e)}",
					".dpo-dock[data-state=\"error\"] .dpo-dock-lead{color:var(--dsw-alias-state-error-primary,#f2777a)}",
					".dpo-dock-title{flex:none;font-weight:500}",
					".dpo-dock-word{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999)}",
					".dpo-dock-word[data-state=\"error\"]{color:var(--dsw-alias-state-error-primary,#f2777a)}",
					".dpo-dock-chevron{flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary,#999)}",
					".dpo-dock-body{display:flex;flex-direction:column;gap:10px;padding:0 12px 12px}",
					".dpo-dock-label{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}",
					".dpo-dock-meta{color:var(--dsw-alias-label-caption,#888);font-size:11px;line-height:16px}",
					".dpo-dock-banner{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.12))}",
					".dpo-dock-banner-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,#ccc);font-size:12px;line-height:18px}",
					".dpo-dock-error{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;background:var(--dpo-acc-12);border:1px solid var(--dpo-acc-22)}",
					".dpo-dock-error-icon{flex:none;display:grid;place-items:center;color:var(--dsw-alias-state-error-primary,#f2777a)}",
					".dpo-dock-error-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,#ccc);font-size:12px;line-height:18px;word-break:break-word}",
					".dpo-dock-link{margin-top:4px;padding:0;border:none;background:0 0;color:var(--dsw-alias-state-business-primary,#4a9eff);font-family:inherit;font-size:12px;cursor:pointer;text-decoration:underline}",
					".dpo-out{box-sizing:border-box;width:100%;min-height:76px;max-height:min(45vh,420px);overflow-y:auto;resize:none;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:var(--dsw-alias-bg-l1,rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:13px;line-height:1.65}",
					".dpo-out:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4a9eff);box-shadow:0 0 0 3px var(--dpo-acc-12)}",
					".dpo-out-live{white-space:pre-wrap}",
					".dpo-fold{border-top:1px solid var(--dsw-alias-border-l1,#333)}",
					".dpo-fold-head{display:flex;align-items:center;gap:8px;width:100%;padding:7px 2px;border:none;background:0 0;text-align:left;cursor:pointer;color:var(--dsw-alias-label-tertiary,#999);font-family:inherit;font-size:12px;line-height:18px}",
					".dpo-fold-head:hover{color:var(--dsw-alias-label-secondary,#ccc)}",
					".dpo-fold-title{flex:none}",
					".dpo-fold-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#888)}",
					".dpo-fold-chevron{flex:none;display:grid;place-items:center}",
					".dpo-fold-body{max-height:180px;overflow-y:auto;padding:0 2px 8px;color:var(--dsw-alias-label-secondary,#ccc);font-size:12px;line-height:1.6;white-space:pre-wrap}",
					".dpo-dock-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,#333);background:var(--dsw-alias-bg-l1,rgba(0,0,0,.10))}",
					".dpo-dock-foot-side{display:flex;align-items:center;gap:8px;min-width:0}",
					".dpo-dock-foot-end{margin-left:auto}",
					".dpo-btn{height:28px;padding:0 12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer}",
					".dpo-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
					".dpo-btn:disabled{opacity:.4;cursor:not-allowed}",
					".dpo-btn.primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4a9eff);color:#fff}",
					".dpo-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4a9eff) 86%,#fff)}",
					".dpo-btn.danger{border-color:transparent;background:var(--dsw-alias-state-error-primary,#d9534f);color:#fff}",
					".dpo-regen-ask{display:flex;flex-direction:column;gap:6px}",
					".dpo-regen-input{box-sizing:border-box;width:100%;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:0 0;color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:12px}",
					".dpo-regen-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4a9eff);box-shadow:0 0 0 3px var(--dpo-acc-12)}",
					".dpo-trace{display:flex;flex-direction:column;gap:2px;padding:0 2px 8px}",
					".dpo-trace-row{display:flex;gap:8px;padding:2px 0;color:var(--dsw-alias-label-secondary,#bbb);font-size:11px}",
					".dpo-trace-tool{flex:0 0 auto;color:var(--dsw-alias-state-business-primary,#4a9eff);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
					".dpo-trace-args{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
					".dpo-trace-meta{flex:0 0 auto;color:var(--dsw-alias-label-caption,#888)}",
					".dpo-tok-chip{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:500;white-space:nowrap}",
					".dpo-tok-live{animation:dpo-pulse 1.6s ease-out infinite}",
					".dpo-dock,.dpo-help-panel{",
					"  --dpo-acc:var(--dsw-alias-state-business-primary,#4a9eff);",
					"  --dpo-acc-12:color-mix(in srgb,var(--dpo-acc) 12%,transparent);",
					"  --dpo-acc-22:color-mix(in srgb,var(--dpo-acc) 22%,transparent);",
					"  --dpo-acc-40:color-mix(in srgb,var(--dpo-acc) 40%,transparent);",
					"}",
					"@keyframes dpo-pulse{0%{box-shadow:0 0 0 0 var(--dpo-acc-40)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}",
					".dpo-out::-webkit-scrollbar,.dpo-fold-body::-webkit-scrollbar,.dpo-help-panel::-webkit-scrollbar{width:8px;height:8px}",
					".dpo-out::-webkit-scrollbar-thumb,.dpo-fold-body::-webkit-scrollbar-thumb,.dpo-help-panel::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-caption,#777) 45%,transparent);border-radius:8px;border:2px solid transparent;background-clip:padding-box}",
					"@media (max-width:720px){.dpo-dock-foot{flex-wrap:wrap}.dpo-dock-foot-end{margin-left:0;width:100%;justify-content:flex-end}}",
					"@media (prefers-reduced-motion:reduce){.dpo-dock *,.dpo-help-panel *{animation:none!important;transition:none!important}}",
				].join("\n");
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, NS + ": styles");

			/* 唯一可见入口：输入框底部工具栏那一行（conversation.input.left）——
			   和「工作区内修改」「模型」这些控件并排，会话里和新对话页完全一致。
			   注册必须幂等（list 槽同 id 同 priority 会抛错），用 captureRegistered 挡重复。 */
			const ensureCaptureRegistration = () => {
				if (store.captureRegistered === true) return;
				store.captureRegistered = true;
				own(() => {
					const dispose = ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
						name: "conversation.input.left",
						id: "prompt-optimizer-input",
						order: 20,
					}, ComposerCapture));
					return () => {
						store.captureRegistered = false;
						if (typeof dispose === "function") dispose();
					};
				}, NS + ": composer capture");
			};
			ensureCaptureRegistration();

			// 自愈：HMR 拆卸竞态后若胶囊没挂上，延时重挂一次（防"UI 全消失"）；挂了就停
			own(() => {
				let tries = 0;
				const timer = window.setInterval(() => {
					tries += 1;
					if (document.querySelector('[data-dpo="chip"]')) {
						if (tries > 1) beacon("controls-healed", { tries });
						window.clearInterval(timer);
						return;
					}
					if (tries === 1) beacon("remount-controls", { tries });
					ensureCaptureRegistration();
					if (tries >= 8) {
						beacon("remount-give-up", { tries });
						window.clearInterval(timer);
					}
				}, 1200);
				return () => window.clearInterval(timer);
			}, NS + ": composer capture self-heal (repeating)");

			/* 右侧栏：注册一个 tab 类型 + 它的表体与标题两个 keyed 槽。
			   key 必须与 tabs.register 的 id 一致，否则槽找不到内容。
			   官方在 sidebar.right.pane.tab 上挂了 inject.hooks.tabInfo，表体组件里
			   用 props.useTabInfo() 取 tab 信息；标题槽返回字符串或 图标+标题 即可。 */
			const ensureSidebarRegistration = () => {
				if (store.sidebarRegistered === true) return;
				store.sidebarRegistered = true;
				own(() => {
					const dispose = ctx.inject(["sidebarRightTabs", "sidebarRight", "layout"], (injected) => {
						const tabs = injected.get("sidebarRightTabs");
						const ctl = injected.get("sidebarRight");
						sidebarRight = ctl || null;
						layoutService = injected.get("layout") || null;
						if (!tabs) return () => {};
						const disposers = [];
						try {
							disposers.push(tabs.register({
								id: SIDEBAR_KIND,
								kind: SIDEBAR_KIND,
								priority: "extension",
								title: () => "提示词优化",
								// 侧栏空态时的引导项：没在跑也能手动打开这个面板
								guide: [{ order: 100, title: () => "提示词优化" }],
							}));
						} catch (e) { beacon("sidebar-register-failed", { error: String((e && e.message) || e), phase: "type" }); }
						try {
							disposers.push(ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
								name: "sidebar.right.pane.tab", key: SIDEBAR_KIND,
							}, PaneHost)));
						} catch (e) { beacon("sidebar-register-failed", { error: String((e && e.message) || e), phase: "body" }); }
						try {
							disposers.push(ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
								name: "sidebar.right.pane.tab.title", key: SIDEBAR_KIND,
							}, OptimizePaneTitle)));
						} catch (e) { beacon("sidebar-register-failed", { error: String((e && e.message) || e), phase: "title" }); }
						/* 第二个 tab：提示词收藏夹。与优化面板并排在同一个右侧栏里。 */
						try {
							disposers.push(tabs.register({
								id: FAV_KIND,
								kind: FAV_KIND,
								priority: "extension",
								title: () => "提示词收藏夹",
								guide: [{ order: 110, title: () => "提示词收藏夹" }],
							}));
							disposers.push(ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
								name: "sidebar.right.pane.tab", key: FAV_KIND,
							}, FavoritesPane)));
							disposers.push(ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
								name: "sidebar.right.pane.tab.title", key: FAV_KIND,
							}, FavoritesPaneTitle)));
						} catch (e) { beacon("sidebar-register-failed", { error: String((e && e.message) || e), phase: "favorites" }); }
						beacon("sidebar-registered", { slots: disposers.length });
						return () => {
							for (const d of disposers.reverse()) { try { d(); } catch (e) { /* noop */ } }
							sidebarRight = null;
							layoutService = null;
						};
					});
					return () => {
						store.sidebarRegistered = false;
						if (typeof dispose === "function") dispose();
					};
				}, NS + ": sidebar tab");
			};
			ensureSidebarRegistration();
			// 全局异常埋点：任何未捕获错误/拒绝都留痕（浮层消失类问题的最后一层证据）
			own(() => {
				const onErr = (e) => beacon("client-error", {
					message: String((e && (e.message || e.error)) || "").slice(0, 300),
					stack: String((e && e.error && e.error.stack) || "").slice(0, 700),
					source: String((e && e.filename) || "").slice(0, 140), line: (e && e.lineno) || null,
				});
				const onRej = (e) => beacon("client-rejection", { reason: String((e && e.reason && (e.reason.stack || e.reason.message)) || (e && e.reason) || "").slice(0, 700) });
				window.addEventListener("error", onErr);
				window.addEventListener("unhandledrejection", onRej);
				return () => { window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
			}, NS + ": error beacons");

			/* 对话里每条用户消息的收藏按钮：先补一次，之后定时自愈。
			   插进去的节点在 React 之外，它重渲染那一排时可能被清掉 —— 扫到没了就补回来。 */
			own(() => {
				const kick = () => { try { ensureMsgFavButtons(); } catch (e) { /* noop */ } };
				kick();
				const t = window.setInterval(kick, 2500);
				// 会话切换 / 历史加载完之后也会冒出新消息，跟着补一次
				window.addEventListener("focus", kick);
				return () => { window.clearInterval(t); window.removeEventListener("focus", kick); };
			}, NS + ": message favorite buttons");

			// 探针触发：轮询 host 命令通道（evidence/cmd.json），token 变化即跑一轮
			let lastToken = window.__DPO_LAST_TOKEN__ || null;
			own(() => {
				const t = window.setInterval(() => {
					fetch(API + "/trace", { cache: "no-store" }).then((r) => r.json()).then((d) => {
						store.trace = d && d.ok ? d : null;
						emit();
					}).catch(() => { /* best effort */ });
				}, 3000);
				return () => window.clearInterval(t);
			}, NS + ": trace poll");
			own(() => {
				const timer = window.setInterval(() => {
					fetch(API + "/cmd", { cache: "no-store" })
						.then((r) => r.json())
						.then((d) => {
							const cmd = d && d.cmd;
							if (!cmd || !cmd.run || !cmd.token || cmd.token === lastToken) return;
							if (window.__DPO_PROBE_RUNNING__ === true) return;
							// 模型弹层自检（宿主下发）：打开弹层 → 数一遍真实渲染出来的条目 → 关闭
							if (cmd.run === "popover-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const popT0 = Date.now();
								store.modelPop = { x: 200, bottom: 260, maxH: 420 };
								store.modelPopOpen = true;
								emit();
								window.setTimeout(() => {
									const pop = document.querySelector('[data-dpo="model-pop"]');
									const r = pop ? pop.getBoundingClientRect() : null;
									beacon("popover-demo", {
										open: Boolean(pop),
										items: document.querySelectorAll('[data-dpo="model-item"]').length,
										groups: document.querySelectorAll('[data-dpo="model-group"]').length,
										loading: Boolean(document.querySelector('[data-dpo="model-loading"]')),
										error: Boolean(document.querySelector('[data-dpo="model-error"]')),
										catalogLoading: store.modelCatalogLoading === true,
										catalogAgeMs: store.modelCatalogAt ? Date.now() - store.modelCatalogAt : null,
										rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
										viewport: { w: window.innerWidth, h: window.innerHeight },
										inView: Boolean(r) && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
										scrollH: pop ? pop.scrollHeight : null, clientH: pop ? pop.clientHeight : null,
										elapsedMs: Date.now() - popT0,
										firstItemText: (() => { const el = document.querySelector('[data-dpo="model-item"]'); return el ? String(el.textContent).slice(0, 40) : null; })(),
										// v51：胶囊状态 + 选中/会话高亮 + 动效是否生效
										pillOpen: (() => { const el = document.querySelector('[data-dpo="model"]'); return el ? el.getAttribute("data-open") : null; })(),
										selectedCount: document.querySelectorAll('[data-dpo="model-item"][data-selected="true"]').length,
										sessionCount: document.querySelectorAll('[data-dpo="model-item"][data-session="true"]').length,
										sessionChips: document.querySelectorAll(".dpo-pop-chip").length,
										popAnim: pop ? getComputedStyle(pop).animationName : null,
										popBlur: pop ? (getComputedStyle(pop).backdropFilter || getComputedStyle(pop).webkitBackdropFilter || null) : null,
									});
									store.modelPopOpen = false;
									emit();
								}, 900);
								return;
							}
							// 端到端自检（宿主下发）：跑一次真优化，只允许在"需要审查"下进行 —— 绝不发送消息
							if (cmd.run === "run-demo") {
								if (store.permission !== "review") { beacon("run-demo-refused", { permission: store.permission }); lastToken = cmd.token; return; }
								if (store.run && (store.run.status === "connecting" || store.run.status === "running")) { beacon("run-demo-deferred", { status: store.run.status }); return; }
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								beacon("run-demo-start", { token: cmd.token, tier: cmd.tier || "basic", permission: store.permission });
								startRun(String(cmd.text || "（自检）把那个页面弄好看点"), cmd.tier || "basic", false);
								const t = window.setInterval(() => {
									if (store.run && store.run.status !== "connecting" && store.run.status !== "running") {
										window.clearInterval(t);
										window.setTimeout(() => {
											beaconOverlayGeom("run-demo-done");
											beacon("run-demo-ui", {
												status: store.run ? store.run.status : null,
												chars: store.run ? String(store.run.text || "").length : 0,
												hasReviewText: Boolean(document.querySelector('[data-dpo="review-text"]')),
												hasConfirm: Boolean(document.querySelector('[data-dpo="confirm"]')),
												hasRegen: Boolean(document.querySelector('[data-dpo="regen"]')),
												hasRollback: Boolean(document.querySelector('[data-dpo="rollback"]')),
												hasGrip: Boolean(document.querySelector('[data-dpo="resize"]')),
												hasFoot: Boolean(document.querySelector('[data-dpo="overlay-foot"]')),
												footButtons: Array.from(document.querySelectorAll('[data-dpo="overlay-foot"] button')).map((b) => b.getAttribute("data-dpo")),
												footInView: (() => { const el = document.querySelector('[data-dpo="overlay-foot"]'); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1; })(),
												tokReasoning: (() => { const el = document.querySelector('[data-dpo="token-reasoning"]'); return el ? String(el.textContent) : null; })(),
												tokNone: Boolean(document.querySelector('[data-dpo="token-reasoning-none"]')),
												tokTotal: (() => { const el = document.querySelector('[data-dpo="token-total"]'); return el ? String(el.textContent) : null; })(),
												usage: store.run && store.run.usage ? Object.keys(store.run.usage).slice(0, 12) : null,
											});
											// 自检收尾：不留浮层、不留运行（演示不产生任何用户可见残留）
											store.run = null;
											store.reviewText = null;
											setOverlay({ open: false });
											beacon("run-demo-end", {});
										}, 200);
									}
								}, 400);
								return;
							}
							// 使用帮助自检（宿主下发）：打开帮助面板 → 数条目/查推荐语 → 关闭
							if (cmd.run === "help-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const hb = document.querySelector('[data-dpo="help"]');
								const r0 = hb ? hb.getBoundingClientRect() : null;
								store.helpPos = r0 ? { x: Math.max(8, Math.min(r0.left - 260, window.innerWidth - 360)), bottom: Math.max(8, window.innerHeight - r0.top + 6), maxH: Math.max(200, r0.top - 16) } : { x: 200, bottom: 260, maxH: 420 };
								store.helpOpen = true;
								emit();
								window.setTimeout(() => {
									const pop = document.querySelector('[data-dpo="help-pop"]');
									const r = pop ? pop.getBoundingClientRect() : null;
									beacon("help-demo", {
										button: Boolean(hb),
										open: Boolean(pop),
										rows: document.querySelectorAll('.dpo-help-row').length,
										sections: document.querySelectorAll('.dpo-help-sec').length,
										tip: (() => { const el = document.querySelector('[data-dpo="help-tip"]'); return el ? String(el.textContent).trim() : null; })(),
										meta: (() => { const el = document.querySelector('[data-dpo="help-meta"]'); return el ? String(el.textContent).trim() : null; })(),
										rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
										inView: Boolean(r) && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
										scrollH: pop ? pop.scrollHeight : null, clientH: pop ? pop.clientHeight : null,
									});
									store.helpOpen = false;
									emit();
								}, 500);
								return;
							}
							// 档位/权限按会话独立 自检（宿主下发）：A 改 → 切 B 改 → 切回 A 应保持 A 的值
							if (cmd.run === "tier-session-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const realSid = store.viewSessionId;
								const t0 = store.tier;
								const p0 = store.permission;
								const other = "__dpo_other_session__";
								setTier(t0 === "advanced" ? "extreme" : "advanced", "ui");
								const tierA = store.tier;
								const permA = store.permission;
								window.setTimeout(() => {
									onViewSessionChange(other);
									setTier("off", "ui");
									const permB0 = store.permission;
									window.setTimeout(() => {
										const bState = { tier: store.tier, permission: permB0, sessionId: store.viewSessionId };
										onViewSessionChange(realSid);
										window.setTimeout(() => {
											const backA = { tier: store.tier, permission: store.permission, sessionId: store.viewSessionId };
											beacon("tier-session-demo", {
												realSid, other,
												a: { tier: tierA, permission: permA },
												b: bState,
												backA,
												pass: bState.tier === "off" && backA.sessionId === realSid && backA.tier === tierA && tierA !== "off",
												mapKeys: Object.keys(store.tierBySession).length,
											});
											// 还原用户原值
											store.tierBySession[realSid] = t0;
											store.permissionBySession[realSid] = p0;
											setTier(t0, "probe-restore");
											if (p0 !== store.permission) setPermission(p0, "probe-restore");
											emit();
										}, 260);
									}, 260);
								}, 260);
								return;
							}
							// 改尺寸自检（宿主下发）：验手柄没被底栏盖住 + 拖拽真的改变尺寸
							if (cmd.run === "resize-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const keepSize = store.overlaySize ? Object.assign({}, store.overlaySize) : null;
								store.suppressUiPersist = true;
								setOverlay({ open: true, text: "改尺寸自检", fullText: "", src: "demo", sessionId: store.viewSessionId });
								emit();
								window.setTimeout(() => {
									const panel = document.querySelector('[data-dpo="overlay"]');
									const grip = document.querySelector('[data-dpo="resize"]');
									const r0 = panel ? panel.getBoundingClientRect() : null;
									const g = grip ? grip.getBoundingClientRect() : null;
									const hit = g ? document.elementFromPoint(Math.round(g.left + g.width / 2), Math.round(g.top + g.height / 2)) : null;
									const hitIsGrip = Boolean(hit && hit.closest && hit.closest('[data-dpo="resize"]'));
									if (grip && panel && g) {
										const pt = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, button: 0, clientX: x, clientY: y });
										const cx = g.left + g.width / 2; const cy = g.top + g.height / 2;
										grip.dispatchEvent(pt("pointerdown", cx, cy));
										grip.dispatchEvent(pt("pointermove", cx - 130, cy - 100));
										grip.dispatchEvent(pt("pointerup", cx - 130, cy - 100));
									}
									window.setTimeout(() => {
										const r1 = panel ? panel.getBoundingClientRect() : null;
										const delta = r0 && r1 ? { dw: Math.round(r1.width - r0.width), dh: Math.round(r1.height - r0.height) } : null;
										beacon("resize-demo", {
											exists: Boolean(panel), gripExists: Boolean(grip),
											gripRect: g ? { l: Math.round(g.left), t: Math.round(g.top), w: Math.round(g.width), h: Math.round(g.height) } : null,
											hitIsGrip, hitWhat: hit ? String((hit.getAttribute && hit.getAttribute("data-dpo")) || hit.className || hit.tagName) : null,
											before: r0 ? { w: Math.round(r0.width), h: Math.round(r0.height) } : null,
											after: r1 ? { w: Math.round(r1.width), h: Math.round(r1.height) } : null,
											delta, stored: store.overlaySize || null,
											pass: Boolean(panel && grip && hitIsGrip && delta && delta.dw <= -120 && delta.dw >= -145 && delta.dh <= -90 && delta.dh >= -115),
										});
										store.overlaySize = keepSize;
										store.suppressUiPersist = false;
										setOverlay({ open: false, sessionId: store.viewSessionId });
										emit();
									}, 260);
								}, 300);
								return;
							}
							// 会话隔离自检（宿主下发）：开一个弹窗 → 切到别的会话 → 切回 → 用 DOM 判定
							if (cmd.run === "session-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const real = store.viewSessionId;
								setOverlay({ open: true, text: "会话隔离自检", fullText: "会话隔离自检", src: "demo", sessionId: real });
								emit();
								window.setTimeout(() => {
									const before = { open: store.overlay.open === true, dom: Boolean(document.querySelector('[data-dpo="overlay"]')), text: store.overlay.text };
									onViewSessionChange("__dpo_other_session__");
									window.setTimeout(() => {
										const away = { open: store.overlay.open === true, dom: Boolean(document.querySelector('[data-dpo="overlay"]')), viewSessionId: store.viewSessionId };
										onViewSessionChange(real);
										window.setTimeout(() => {
											const back = { open: store.overlay.open === true, dom: Boolean(document.querySelector('[data-dpo="overlay"]')), text: store.overlay.text, viewSessionId: store.viewSessionId };
											beacon("session-demo", {
												realSession: real, before, away, back,
												pass: before.dom === true && away.dom === false && back.dom === true && back.text === before.text && away.viewSessionId === "__dpo_other_session__",
											});
											setOverlay({ open: false, sessionId: real });
											store.stash = {};
											emit();
										}, 320);
									}, 320);
								}, 320);
								return;
							}
							// 控件行自检（宿主下发）：量滑块长度/字号/是否换行或被裁 —— 验证"舒适度"是数字而不是感觉
							if (cmd.run === "controls-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								window.setTimeout(() => {
									const box = document.querySelector('[data-dpo="controls"]');
									const tierTrack = document.querySelector('[data-dpo="tier-track"]');
									const permTrack = document.querySelector('[data-dpo="perm-track"]');
									const tierVal = document.querySelector('[data-dpo="tier-value"]');
									const permVal = document.querySelector('[data-dpo="perm-value"]');
									const pill = document.querySelector('[data-dpo="model"]');
									const r = box ? box.getBoundingClientRect() : null;
									const fs = (el) => (el ? getComputedStyle(el).fontSize : null);
									const tw = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
									beacon("controls-demo", {
										exists: Boolean(box),
										controls: r ? { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), right: Math.round(r.right) } : null,
										viewport: { w: window.innerWidth, h: window.innerHeight },
										tierTrackW: tw(tierTrack), permTrackW: tw(permTrack),
										trackH: tierTrack ? Math.round(tierTrack.getBoundingClientRect().height) : null,
										fonts: { tierValue: fs(tierVal), permValue: fs(permVal), model: fs(pill) },
										wrapped: Boolean(r) && r.height > 40,
										clipped: box ? box.scrollWidth > box.clientWidth + 1 : null,
										overflowRight: Boolean(r) && r.right > window.innerWidth,
										narrow: store.narrow === true,
									});
								}, 400);
								return;
							}
							// 纯可见性自检（宿主下发）：只开关一次浮层，不跑优化、不改档位、不发消息
							if (cmd.run === "overlay-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								beacon("overlay-demo-start", { token: cmd.token, activeInstance: isActiveInstance(), tier: store.tier, permission: store.permission });
								setOverlay({ open: true, text: "浮层可见性自检（不优化、不发送）", fullText: "", src: "demo" });
								window.setTimeout(() => { beaconOverlayGeom("demo"); }, 300);
								window.setTimeout(() => { setOverlay({ open: false }); beacon("overlay-demo-end", {}); }, 7000);
								return;
							}
							/* ⚠️ 闸门一：未知命令一律拒绝，绝不回落到通用探针。
							   上游 v0.1.4 的事故就是这里 —— 一条拼错的命令没匹配到任何分支、
							   掉进通用探针，热重载打断后自清场没跑完，探针的投递标记被提交进了真实会话。 */
							if (cmd.run !== "selftest") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								beacon("cmd-unknown", { run: String(cmd.run).slice(0, 60), token: cmd.token });
								return;
							}
							/* ⚠️ 闸门二：探针必须显式投递授权（deliver:true），否则只记一次拒绝。 */
							if (cmd.deliver !== true) {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								beacon("probe-refused", { token: cmd.token, reason: "no-deliver-grant" });
								return;
							}
							// 用户忙就不抢：优化在跑 / 卡片开着 / 输入框有草稿 → 让路（不消耗 token，稍后再试）
							const busyRun = store.run && (store.run.status === "connecting" || store.run.status === "running");
							const draftBusy = String(draftLive() || "").trim().length > 0;
							if (busyRun || store.overlay.open || draftBusy) {
								beacon("probe-deferred", {
									reason: busyRun ? "run-in-flight" : (store.overlay.open ? "overlay-open" : "draft-non-empty"),
									token: cmd.token, tier: store.tier, permission: store.permission,
								});
								return;
							}
							window.__DPO_PROBE_RUNNING__ = true;
							lastToken = cmd.token;
							window.__DPO_LAST_TOKEN__ = cmd.token;
							beacon("probe-start", { token: cmd.token, cmdAgeMs: d.cmdAgeMs === undefined ? null : d.cmdAgeMs, tier: store.tier, permission: store.permission });
							runProbe(ctx, cmd.token).catch((e) => {
								window.__DPO_PROBE_RUNNING__ = false;
								store.probeError = String(e);
								emit();
								void post("/report", { plugin: NS, token: cmd.token, kind: "selftest-error", error: String(e), windowStart: Date.now(), windowEnd: Date.now(), steps: [], passed: 0, total: 0 });
							});
						})
						.catch(() => { /* host 未就绪时静默 */ });
				}, 2000);
				return () => window.clearInterval(timer);
			}, NS + ": probe poll");

			// 控制台手测入口（与探针同一套判定真源）
			window.__DPO__ = {
				store,
				labels: () => [...SEND_LABELS],
				interceptKey,
				wouldInterceptClick,
				cardOf,
				editorOf,
				disarm: () => { store.armed = false; return store.armed; },
				arm: () => { store.armed = true; return store.armed; },
				probe: (token) => runProbe(ctx, token || "manual-" + Date.now()),
			};
		};

		return module.exports;
	}
});
