# Handoff: Apollo — Unified RCA Product

Apollo is an AI root-cause-analysis product unifying two existing engines into one application:
- **Code-level RCA** (`rca-agent` / Apollo repo) — watches services, classifies errors, runs a Claude ReAct loop over GitLab code/commits/deploys to pin a defect.
- **Infrastructure RCA** (`infra-rca` repo) — pulls metrics/traces/logs/events from Datadog and live object state from the Kubernetes API to diagnose OOMKills, DB pool exhaustion, unschedulable pods, etc.

Both share one spine: a self-describing **integration/tool registry** (observability, GitLab, CI/CD, Kubernetes, config, cloud light up as agent tools when connected) feeding a streaming **ReAct investigation** that ends in an evidence-backed root-cause report, worked collaboratively by invited people.

## About the design file
`Apollo.dc.html` is a **design reference created in HTML** — a clickable prototype showing intended look and behavior. It is **not production code to copy directly.** It is a single self-contained file: an inline-styled template plus a small JavaScript logic class (`class Component`) exposing render values. All styling is inline; all agent output, tool calls, evidence, incidents, and integration state are **mocked**.

The task is to **recreate these designs in the target codebase** (`rca-agent/.../ui` and `infra-rca/ui` are React) and wire them to live data: the real ReAct agent stream, the tool/integration registry, real incidents and evidence artifacts. State, routing, auth, and storage come from your existing app.

**Fidelity: high.** Final colors, type, spacing, and interactions are specified — recreate pixel-faithfully with your component libraries.

---

## Design Tokens

### Neutrals
| Token | Hex |
|---|---|
| App background | `#F6F7F9` |
| Surface / card | `#FFFFFF` |
| Surface subtle | `#FBFBFC` / `#FAFAFB` / `#FAFBFA` |
| Border | `#E6E8EB` |
| Hairline divider | `#EDEEF1` / `#F0F1F4` / `#F4F5F7` |
| Control border | `#DADCE0` |
| Text primary | `#16181D` |
| Text body | `#3A3E46` |
| Text secondary | `#5B616E` |
| Text muted | `#9197A1` |

### Brand & semantic
| Token | Value | Use |
|---|---|---|
| **Accent (themeable)** | default Indigo `#5B5BD6` | primary accent, agent identity, active nav, primary buttons |
| Accent deep | `#4F4FCB` | active nav text, role badge |
| Accent tint | `#EEEEFB` | active nav bg, "investigating" chips, steering pills |
| Accent gradient | `linear-gradient(135deg,#5B5BD6,#8A6BF0)` | agent/org avatars |
| Critical / error | fg `#C13438`/`#E5484D`, bg `#FCECEC`, border `#F5C6C7` |
| Warning / high | fg `#B45309`, bg `#FBEEDC` |
| Medium | fg `#9A7B0A`, bg `#FAF4DA` |
| Success / resolved | fg `#1F8A5B`/`#30A46C`, bg `#E7F6EE`/`#EAF6F0`, border `#CDEBDD` |
| Near-black (dark btn) | `#16181D` |

**The accent is implemented as a CSS variable** (`--ap-accent`, `--ap-accent-deep`, `--ap-accent-tint`, `--ap-accent-grad`) set on the root element, with indigo fallbacks (`var(--ap-accent,#5B5BD6)`) so it paints instantly. In production, drive these from a theme/brand setting.

### Integration brand colors
Datadog `#7C5CFC` ◐ · GitHub/GitLab `#E2502B` ⌥ · Kubernetes/EKS `#326CE5` ⎈ · CI/CD `#1F8A5B` ⟲ · Configuration `#5B616E` ⚙ · AWS `#C2780C` ☁.
(The unicode glyphs are **placeholders — replace with real icons / official integration logos.**)

### Type
- **Sans:** Geist (400/500/600/700), fallback `system-ui,-apple-system,'Segoe UI',sans-serif`.
- **Mono:** Geist Mono — service names, queries, code, IDs, metrics.
- Scale: page titles 20–26/600–700; incident headline 18/600; body 13–14.5; metadata 11–12.5; uppercase eyebrow labels 11/600 (+.05em); mono inline 11–12.
- Headings letter-spacing −.01em…−.02em. Body line-height 1.5–1.6.

### Spacing / radius / shadow / motion
- Spacing rhythm 4/7/9/12/14/18/22/26px.
- Radius: pills 20; controls 7–9; cards 11–16; avatars 50%; message bubbles `4px 12px 12px 12px`.
- Shadows: dropdown `0 12px 32px rgba(16,18,29,.12)`; modal `0 24px 60px rgba(16,18,29,.28)`.
- Keyframes: `ap-pulse` (live status dots), `ap-shimmer` (loading), `ap-spin` (test-connection spinner), `ap-rise` (message entrance).

---

## App shell (persistent)
Full-viewport flex row. **Sidebar 228px** (`#FFF`) + main area (column, `overflow:hidden`).

Sidebar top→bottom:
- **Org switcher** — gradient mark + org name + "prod · 14 services"; click → dropdown listing orgs (current checked, Northwind Labs, All organizations) + **Create organization** (opens the org wizard). This is the multi-org mechanism.
- **Nav** — Home, Incidents (red "5" badge), Investigations (live pulsing dot), Integrations (**ADMIN** tag — admin-only), divider, Reports, Eval Suite. Active = accent-tint bg + accent-deep text.
- **User block** (bottom) — avatar + name + "{role} · on-call"; click → **Profile**.

Router state `screen`: `home | incidents | workbench | integrations | profile`. Full-screen takeovers via `overlay`: `accept` (invite signup) and `org` (create-org wizard). Modals: invite (`inviteOpen`), integration config (`configKey`). **Replace with real routing.**

---

## Screens

### 1. Home / Launch (default)
Greeting + on-call pill; a dark **"Launch Apollo"** hero (service picker / paste-alert input → Launch investigation); **3 focused stats** (Active incidents 5 · 2 critical, Investigating now 1, Median time-to-root-cause 4m 12s — *deliberately only the relevant few*); two columns: **Active investigations** list (click → workbench) and **Connected stack** health (per-source status dots, Manage → integrations).

### 2. Incidents
Header with title, a **filter bar** (Search + Severity + Status + Time-range dropdowns) and **New investigation**; 4 stat cards; a table (Severity / Incident / Sources / Status / People / Age) over the **real planted scenarios** (cross-service NPE, OOMKilled checkout, DB pool exhaustion, unschedulable demo pods, pricing ArithmeticException, resolved banking-app NPE). Rows click → workbench.

### 3. Investigation Workbench (hero)
Live, collaborative investigation room.
- **Header** — incident id, Critical chip, **Investigating/Paused** chip, headline, service chain, onset & rate; **participant avatar stack** with add (+); Share; **Resolve incident**.
- **Center timeline** — the ReAct loop as a narrative: phase chips (Triage / What changed / Code analysis), agent **reasoning** blocks, **tool-call cards** rendering real evidence (Datadog metric spike chart, K8s pod table, CI/CD deploy list, GitLab diff + file), **observation** blocks (ruled-out / suspect / confirmed), a **human steer** message + agent acknowledgement, dynamic user messages, and a "joined" banner.
- **Inline root-cause report** (the agent's concluding turn — full report lives in the chat, not a sidebar): confidence bar (94%), summary, **evidence-linked numbered causal chain** (each step ① CI/CD #1843 ② GitLab a3f9c2 ③ GitLab OrderService:88 ④ Datadog+K8s), **Supporting evidence** chips (6 sources), **Remediation** (3 ranked fixes), **Export report / Create Jira**.
- **Composer** — Steer / Comment toggle + live status; auto-grow textarea; **Stop** button (kills the in-progress run, becomes **Resume**) sits **next to Send**. Enter posts; messages append to thread; steer messages are read by the agent live.
- **Right rail** (ongoing context; hidden in Focus view) — **Investigation context** (services, onset, error-rate spark, suspect release), **Evidence collected**, **In this room** (presence; + Add people opens invite).

### 4. Integrations
"Connect any deployed app" onboarding: capability/depth meter (additive — depth scales with what you connect, no hard requirements), then a 2-col grid. Each card: glyph + name + Connected/Not-connected status + description + tool count + **Connect/Manage** → **per-integration config modal**.

**Integration config modal** (per source): fields specific to that integration —
- Datadog: API key, Application key, Site
- GitHub/GitLab: Provider, Base URL, PAT, Default group/org
- Kubernetes/EKS: Cluster name, API server URL, Service-account token, Namespace scope
- CI/CD: Provider, API token, Pipeline/project scope
- Configuration: Source, Location/URL, Access token
- AWS Cloud: Access method, Role ARN, External ID, Regions
…plus **Test connection** (runs → returns an authenticated result like "Authenticated · 14 services & 6 monitors visible") and a **Connect / Save changes** CTA. **In production, wire Test connection to a real credential check per provider.**

### 5. Profile + roles
Identity card (avatar, name, email, role badge); **Preview as Admin / Member** prototype switch (flips gating live); Notifications toggles; **admin-only** Workspace administration (Integrations, Create org, Members list with roles + Invite). Members see a read-only note. Two roles: **Admin** (configures integrations, manages members/orgs) and **Member** (investigates, joins rooms). Integrations nav + screen are admin-gated.

### 6. Invite flow (end-to-end, simulated, no passwords)
**"+ Add people"** → invite modal (email + role) → **Send** → magic-link + "Preview what they'll receive" → **invite-accept takeover** ("Devin invited you to investigate INC-2043", incident preview, name, **Join investigation** — no password) → lands in the workbench as a participant (joined banner; presence flips viewing→active).
**Auth approach: magic-link only — the invite link is the credential.** Main app assumes logged-in; no sign-in screen. In production, back this with magic-link/SSO; no password system required.

### 7. Create-organization wizard (overlay)
3 steps: **① Org details** (name, environment) → **② Connect first source** (pick one; no hard requirement) → **③ Invite team** (emails, magic-link) → creates the workspace and lands on Home. (Region intentionally omitted — it's a data-residency detail for integration config, not onboarding.)

---

## Tweakable props (host Tweaks panel — `data-props` on the DC; read via `this.props`)
These are expressive, feel-level controls (not pixel tweaks). In production, map to a theme/settings layer.
- **accent** — `Indigo | Teal | Violet | Amber`. Re-themes the entire accent via the CSS variables above.
- **workbenchView** — `Split | Focus`. Split shows the context rail; Focus hides it for an immersive reasoning stream (the inline report keeps the verdict visible either way).
- **motion** — `Live | Calm`. Calm disables all pulse/shimmer/spin animation (`.ap-calm *{animation:none}`).

---

## Interactions & state
Prototype state to recreate with your store + router:
- `screen` → **real routes** (`/`, `/incidents`, `/investigations/:id`, `/integrations`, `/profile`).
- `role` (admin|member) → real RBAC; gates Integrations + admin sections.
- `overlay` (accept|org), `inviteOpen`, `configKey` → real invite/onboarding/connect flows + realtime room membership & presence.
- `draft`/`mode`/`userMessages` → posting into the room over your realtime channel; agent consumes steer messages live.
- `agentStopped` → real pause/kill of the running investigation.
- `testState` (idle|testing|ok) → real per-provider credential test.
- **Mocked, must come from backend:** the ReAct event stream (reasoning/tool_call/observation/human_message/agent_ack), per-tool evidence artifacts, the root-cause report (confidence, causal chain, remediation), incident list + stats, integration connection states + tool counts, participants/presence.

Note (prototype implementation detail, not a design requirement): integration **Connect/Manage** buttons use a delegated `[data-int]` click handler in `componentDidMount` rather than a per-row inline handler. In React, just use a normal `onClick={() => openConfig(name)}`.

### Suggested data shapes (guide)
- `Incident { id, severity, title, service, sources[], status, peopleCount, age }`
- `InvestigationEvent = reasoning{text} | tool_call{source,query,durationMs,evidence} | observation{kind,text} | human_message{author,text,isSteer} | agent_ack{text}`
- `RootCause { summary, confidence, chain: {claim, source, ref}[], remediation: string[] }`
- `Integration { name, glyph, color, connected, toolCount, description, fields: {label,kind,options?}[], testMessage }`
- `Participant { name, initials, color, role, presence }`

## Responsive
Desktop-first (≈1280px+). Sidebar 228 fixed, center fluid, rail 372 fixed. Below ~1100px: collapse rail to a drawer, sidebar to icons. Follow your breakpoints.

## Assets
- Fonts: Geist + Geist Mono (Google Fonts) — use your app's font loading.
- Icons/glyphs are CSS-drawn marks or unicode placeholders — **replace with your icon set and official integration logos**. No raster assets.

## Files
- `Apollo.dc.html` — the full design (all screens + overlays + shell). Open in a browser to click through. Template = layout; the `class Component` block holds mocked data + interaction logic (`renderVals()` returns everything the markup binds to).

## Source repos
- `rca-agent/` (Apollo) — code-level RCA engine, RCA ReAct loop, GitLab tools, error ingestion, `projects.yaml` registry, existing React UI.
- `infra-rca/` — infra RCA agent (`app/agent`, `app/tools`, `app/pipeline`, `app/services`, `app/state`), Datadog + Kubernetes tools.
The target is one unified product surfacing both engines through the shared Workbench.
