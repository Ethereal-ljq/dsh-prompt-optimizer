# dsh-prompt-optimizer · Prompt Optimizer (DSH Web plugin)

[中文](README.md) ｜ **English**

> 🌐 **UI language notice**: the plugin's **user interface is currently Chinese-only** — there is no English (or other) UI yet. This English README is documentation only; after installation the interface stays Chinese.
> **界面语言说明**：本插件的操作界面目前有且只有中文。

---

## ⚠️ Four points to read first (author's statement)

1. **The purpose of this plugin is to optimize prompts** — to save the time you would otherwise spend writing them, and to help you convey your intent more accurately. In essence, it gives the AI **one extra step of self-planning and self-constraint**.
2. It has a **clear effect on capable-but-prompt-sensitive models** such as **DeepSeek-V4.1-Flash** — models that are strong, yet whose performance is heavily influenced by how the prompt is written.
3. The author has **only tested this plugin on some OneShot-type tasks**, where it achieved **breakthrough results**. Therefore **no guarantee is made that it will have a large positive effect on every task** — **please keep a conservative view of its practical value**.
4. This plugin is **fully open source**: **anyone** may use and modify it **in any form**, and **suggestions and all kinds of testing are welcome**.

---

## What it does

The moment you press Enter in the composer, your message is **not** sent directly — a **second AI (a "relay")** first turns it into a **command that can be sent to your working AI as-is**, and you decide whether to send it after seeing the result.

- It is a **relay, not a chat partner**: the optimizer AI knows it is "conveying the user's intent to the working AI". It does **not answer you, does not do the work for you, and does not ask you questions**. Its output is the command body itself (no meta sections such as "Optimized prompt / Change log"), ready to be pasted to the downstream AI.
- The optimizer **model, tier and permission are independent of your conversation** — your chat model is never touched.
- **Tier and permission are per-session**: setting session A to "Extreme + Auto" leaves session B untouched.
- The **interception card is session-isolated**: a card triggered in A never pops up in B, and comes back as-is when you return to A (if it is still waiting for your decision).

Author: **啃轮胎的西狐** · Version **0.1.1beta1** · Release date **2026/09/11** (the same credit appears at the bottom of the in-plugin Help panel)

---

## 1. Installation

### Option A — install it like any other DSH plugin (recommended)

Two steps: install the package into your profile, then register it as a bundle layer.

```bash
# 1) install the package (GitHub repo / tarball / local dir all work)
dsh plugin --profile web add github:WestFox-AwA/dsh-prompt-optimizer#v0.1.1-beta.1
dsh plugin --profile web add ./dsh-external-dsh-prompt-optimizer-0.1.1-beta.1.tgz

# 2) add one line to dsh.profile.bundles in ~/.dsh/profiles/web/package.json:
#      "@dsh-external/dsh-prompt-toolkit"
```

Restart DSH and you are done. **Why the bundles edit is needed**: `dsh plugin` merely forwards its arguments to pnpm (installation only); which packages take part in assembly as bundle layers is decided by `dsh.profile.bundles`. This package ships its own `cordis.patch.yml` and inserts its entry into the root entry list during assembly — **exactly the same pattern** as `@dsh-external/dsh-super-injector` and `@dsh-external/dsh-graded-mode`.

### Option B — keep bundles untouched, insert via the profile patch

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml (a top-level YAML array)
- insert:
    - id: prompt-optimizer
      name: '@dsh-external/dsh-prompt-toolkit'
      config: {}
```

The package still has to be resolvable (`dsh plugin add`, or a manually created `node_modules` symlink/junction).

> ⚠️ **Use either Option A or Option B, never both** — doing both inserts the same entry twice and DSH fails to boot with `duplicate loader entry id`.

### Verify the installation

```bash
dsh --dump-config --profile web | grep -A2 'id: prompt-optimizer'   # present, and exactly once
node -e "console.log(require.resolve('@dsh-external/dsh-prompt-toolkit',{paths:['<profile dir>']}))"
```

### Requirements

- **DSH Web** (`dsh web`; this plugin only provides UI on the web platform).
- At least one working LLM route (by default optimization follows the current session model; you can also pick a dedicated model from the plugin's model pill).
- The plugin has **zero runtime dependencies and needs no build** (`lib/` contains runnable JavaScript).

---

## 2. Quick start (30 seconds)

1. Type as usual in the composer and press **Enter** (or click send).
2. The message is intercepted and a **collapsible card** appears **directly above the composer**, its header row showing the state (`Optimizing…` / `Needs review` / `Failed`).
3. With permission **Review**: the card expands automatically and **Output** is the command about to be sent — edit it directly → click **Confirm & send**; not satisfied? click **Regenerate** (it asks you for a direction first).
4. With permission **Auto**: it is sent automatically as soon as optimization finishes — no action needed.
5. Do not want to optimize? Click **‹ Roll back** (stop + collapse + **send nothing** + your original text stays in the composer), or **Send original** to send your original text.

> Every entry point is now a single pill at the bottom of the composer: **`✦ Optimize <current tier> ˅`**, right after the access selector. Clicking it opens a vertical menu: **Tier / Permission / Model / Help**. It is the same control, in the same place, both inside a session and on the new-conversation screen.

---

## 3. What is inside that pill

Click the `✦ Optimize …` pill at the bottom of the composer; from top to bottom it holds four groups:

| Group | Values | Notes |
|---|---|---|
| **Tier** | Off / Basic / Advanced / Extreme | Off = no interception at all; Basic = just say it clearly (~3 s); Advanced = add the obviously-needed constraints and acceptance criteria (~20 s); Extreme = **read the real project structure** (read-only, never writes) and produce a staged action plan + acceptance criteria + contingencies (~20 s) |
| **Permission** | Review / Auto | Review = editable output, sent only when you confirm; Auto = sent as soon as optimization finishes (**and if optimization fails, the original text is sent** — it never silently swallows your message). Greyed out while Tier is "Off" |
| **Model** | any provider/model | Affects optimization only, never your chat model. **Providers are collapsed**: each one takes a single row by default (`▸ DeepSeek · 4 models`), and clicking it reveals that provider's models. **The provider holding the current selection expands automatically when you open the menu**, the rest stay collapsed — so even with four or five providers configured the menu stays short. Unreachable providers are labelled "unreachable" and never slow the list down |
| **Help** | — | The short tutorial (how it works / tier / permission / card buttons + the recommended combination); a small **‹ Back** in its top-left corner returns to the menu |

> **To use every capability automatically, use [Extreme] + [Auto].**

---

## 4. The interception card

When a message is intercepted, the card appears **directly above the composer** — the same place the official todo panel and queued-message panel use.

- **Fixed position, no floating** — it is aligned with the composer and is an ordinary block in the page layout: nothing to drag, no size to resize, and it never covers the conversation.
- **Collapsible** — the header row (status dot + title + state + tokens) *is* the toggle. It stays collapsed while running (barely any space), and **expands automatically in the review state** so you can see what is about to be sent.
- **Output is the main character** — directly editable, and its height grows with the content (a single scrollbar appears only when it is genuinely very long).
- **"Thinking" and "Checked" are collapsed to one line each** — click the title to expand. The Thinking title shows this run's reasoning tokens (`— tok` when the provider does not report usage).
- **A fixed four-button action bar** — `‹ Roll back` / `Send original` / `Regenerate` / `Confirm & send`. Their position and count **never change** in any state (unavailable ones are merely greyed out while running), so you never have to hunt for a different set of buttons.
- **State at a glance** — `Optimizing…` shows a pulsing blue dot, `Needs review` a green dot, `Failed` a red dot; the header's right side shows the total usage (e.g. `Σ 1.1k tok`).
- **Session-isolated** — the card belongs to the session that triggered it.

---

## 5. FAQ

| Symptom | Cause / fix |
|---|---|
| Enter seems to do nothing and the message is not sent | You are inside the optimization flow — watch the **card above the composer**; if it is not visible, switch to that session and it reappears |
| Optimization is slow | Advanced/Extreme take about 20 s (Extreme also reads project structure). Use **Basic** for speed |
| "Optimizer model unavailable → sent the original text" | The selected model is unreachable (e.g. local `ollama` not running). The plugin **falls back to the session default model** automatically |
| Temporarily disable it | Open the pill → Tier → "Off" |
| A provider is labelled "unreachable" | That provider is unavailable right now (not running / no credentials); other models are unaffected |
| Can I switch the UI to English? | **Not yet** — the UI is currently Chinese-only |

---

## 6. Uninstall

```bash
dsh plugin --profile web remove @dsh-external/dsh-prompt-toolkit
```

If you used Option B, also delete the `insert` entry from `cordis.patch.yml`. Plugin settings live in `~/.dsh/prompt-optimizer.json` (tier / permission / model / per-session settings); delete it too for a full cleanup.

---

## 7. Implementation notes (for people who want to modify it)

- **Two halves**: `lib/index.js` (host: tier system prompts and the relay framing, read-only tool loop, SSE streaming runs, model catalog, state persistence, HTTP routes) + `lib/client.js` (browser: the entry pill, its vertical menu, the help panel, the interception card above the composer, capture-phase interception of Enter and the send button).
- **The UI reuses official primitives wherever possible**: the pill and the menu it opens are built on the shell-provided `@deepseek-ai/dsh-client-ui-primitives` (`Menu`, `Icon*16`, `useAnchoredPosition`, …). Shell chrome, row height, the selected ✓, portal positioning, outside-click dismissal and viewport clamping are all official implementations — which is why it looks like DSH's own menus and will follow theme changes on its own.
- **Mount points**: the entry pill mounts at `conversation.input.left` (present both inside a session and on the new-conversation screen, with identical behaviour); the interception card mounts at `conversation.input.dock` (the same slot as the official todo and queued-message panels — an ordinary in-flow block, neither floating nor covering anything).
- **Interception happens in the capture phase** on `window` (before React and the editor's own handlers): `Shift+Enter`, `/` commands, empty drafts, attachments-only, and Enter outside the composer card all pass through.
- **The official send path is untouched**: confirming uses the official `inputActions.setDraft()` + `submit()`, exactly the same route as a manual send; "Send original" uses the full original captured at interception time.
- The artifact is plain JavaScript (no build step). `ACCEPTANCE.md` is a cell-by-cell acceptance checklist; `evidence/` holds machine traces (self-test reports, telemetry, comparisons).

---

## 8. Privacy and boundaries

- Optimization requests send only **the text you typed**, plus (Advanced/Extreme) a **directory-tree summary and key file names of the current project**. Extreme-tier read-only checks are confined to the project root: no writes, no command execution.
- The interception card sends nothing by default: only "Confirm & send", "Auto" and "Send original" hand content back to the official send path.
- The plugin is a local client + host plugin and talks to no third-party service.

---

## 9. License and collaboration

**BSD-3-Clause**. Fully open source: **anyone** may use and modify it **in any form**; issues, pull requests and all kinds of testing feedback are welcome. See [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md).
