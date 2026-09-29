// Modified for CodeLoop.
(() => {
  "use strict";

  const VERSION = "0.6.8";
  const SOURCE_HASH = window.__CODEX_TASKBOARD_SOURCE_HASH__;
  const SENTINEL_KEY = "__codexTaskboardInjection__";
  const DEFAULT_TASKBOARD_URL = "http://127.0.0.1:47824/?host=codex";
  const ENTRY_ID = "codex-taskboard-entry";
  const PAGE_ID = "codex-taskboard-page";
  const FRAME_ID = "codex-taskboard-frame";
  const DRAG_REGION_ID = "codex-taskboard-drag-region";
  const NO_DRAG_LEFT_ID = "codex-taskboard-no-drag-left";
  const NO_DRAG_RIGHT_ID = "codex-taskboard-no-drag-right";
  const STATUS_ID = "codex-taskboard-status";
  const STYLE_ID = "codex-taskboard-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-taskboard-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-taskboard-native-hidden";
  const AUTOMATION_PLACEHOLDER_ATTRIBUTE = "data-codex-taskboard-automation-placeholder";
  const HOST_ATTRIBUTE = "data-codex-taskboard-page-host";
  const NATIVE_ICON_ATTRIBUTE = "data-codex-taskboard-native-icon";
  const HOST_BINDING_NAME = "__codexTaskboardHostV2";
  const HOST_HEARTBEAT_NAME = "__codexTaskboardHostHeartbeatV2";
  const REATTACH_DELAY_MS = 160;
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const HOST_REQUEST_TIMEOUT_MS = 60_000;
  const HOST_HEARTBEAT_MAX_AGE_MS = 8_000;
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const FRAME_REFRESH_PARAM = "__codex_taskboard_refresh";
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_OUTLINE_ICONS = {
    "builtin:home": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M9.16491 2.63173C9.71169 2.48215 10.289 2.48212 10.8358 2.63173C11.1778 2.72543 11.48 2.8889 11.7938 3.10145C12.1009 3.3095 12.4556 3.58934 12.8905 3.93251L17.079 7.23817L17.3319 7.43837V7.44032L18.329 8.22841C18.6169 8.45595 18.6666 8.87383 18.4393 9.162C18.2118 9.4502 17.793 9.49877 17.5048 9.27138L17.3319 9.13466V13.9999C17.3319 14.4554 17.3329 14.8371 17.3075 15.1483C17.2814 15.4673 17.2245 15.7709 17.078 16.0585C16.8546 16.4969 16.4978 16.8535 16.0594 17.077C15.772 17.2235 15.4682 17.2804 15.1493 17.3065C14.8382 17.3319 14.4562 17.3319 14.0008 17.3319H11.4188V13.9579C11.4186 13.175 10.7837 12.5404 10.0008 12.5399C9.21764 12.5399 8.58209 13.1747 8.5819 13.9579V17.3319H6.00084C5.54535 17.3319 5.16262 17.3319 4.85143 17.3065C4.53266 17.2805 4.22966 17.2234 3.94225 17.077C3.5036 16.8535 3.14627 16.4971 2.92272 16.0585C2.77621 15.7709 2.72027 15.4673 2.6942 15.1483C2.6688 14.8371 2.66881 14.4554 2.66881 13.9999V9.13466L2.49596 9.27138C2.20783 9.49885 1.79002 9.44991 1.56237 9.162C1.33486 8.87382 1.3837 8.45603 1.67174 8.22841L2.66881 7.44032V7.43837L2.92174 7.23817L7.1112 3.93251C7.54597 3.58945 7.89989 3.30942 8.2069 3.10145C8.52085 2.88883 8.82275 2.7254 9.16491 2.63173ZM9.99596 3.8495C9.91933 3.84967 9.84263 3.85439 9.76647 3.86415C9.68232 3.87496 9.59887 3.89241 9.51647 3.91493C9.42142 3.94095 9.31925 3.98378 9.19127 4.05556C9.12054 4.09534 9.04147 4.14337 8.95202 4.20399C8.69423 4.37873 8.38416 4.62336 7.93444 4.97841L3.99889 8.08485V13.9999C3.99889 14.4775 3.99942 14.7964 4.0194 15.0409C4.03875 15.2773 4.07319 15.3861 4.10827 15.455C4.20432 15.6432 4.35748 15.7965 4.54577 15.8925C4.61466 15.9275 4.72363 15.962 4.95983 15.9813C5.20432 16.0013 5.52348 16.0018 6.00084 16.0018H7.25182V13.9579C7.25201 12.4402 8.4831 11.2099 10.0008 11.2099C11.5182 11.2103 12.7487 12.4405 12.7489 13.9579V16.0018H14.0008C14.478 16.0018 14.7965 16.0013 15.0409 15.9813C15.277 15.962 15.3861 15.9275 15.4549 15.8925C15.6432 15.7964 15.7975 15.6433 15.8934 15.455C15.9285 15.3861 15.962 15.2772 15.9813 15.0409C16.0013 14.7964 16.0018 14.4775 16.0018 13.9999V8.08388L12.0673 4.97841C11.6172 4.6231 11.3066 4.37881 11.0487 4.20399C10.7979 4.034 10.6327 3.95536 10.4852 3.91493C10.3662 3.88233 10.2442 3.86252 10.1219 3.85438C10.08 3.8516 10.038 3.8494 9.99596 3.8495Z\" fill=\"currentColor\"/>",
    "builtin:automations": "<path d=\"M10 5.16895C10.3673 5.16895 10.665 5.46672 10.665 5.83398V9.82812C10.6649 10.1147 10.5513 10.3901 10.3486 10.5928L8.3877 12.5547C8.12804 12.814 7.70591 12.8141 7.44629 12.5547C7.18668 12.2951 7.18687 11.873 7.44629 11.6133L9.33496 9.72461V5.83398C9.33496 5.46685 9.63291 5.16916 10 5.16895Z\" fill=\"currentColor\"/> <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M10 1.83496C14.5094 1.83496 18.165 5.49059 18.165 10C18.165 14.5094 14.5094 18.165 10 18.165C5.49059 18.165 1.83496 14.5094 1.83496 10C1.83496 5.49059 5.49059 1.83496 10 1.83496ZM10 3.16504C6.22513 3.16504 3.16504 6.22513 3.16504 10C3.16504 13.7749 6.22513 16.835 10 16.835C13.7749 16.835 16.835 13.7749 16.835 10C16.835 6.22513 13.7749 3.16504 10 3.16504Z\" fill=\"currentColor\"/>",
    "builtin:library": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M14.1313 2.37447C15.3086 2.16719 16.4314 2.95315 16.6392 4.13033L18.4331 14.3071C18.6405 15.4844 17.8545 16.6071 16.6772 16.8149L15.2817 17.061C14.1043 17.2685 12.9815 16.4816 12.7739 15.3042L12.2905 12.5629V15.1665C12.2905 16.3619 11.3208 17.3311 10.1255 17.3315H8.7085C8.12542 17.3315 7.59678 17.0999 7.20752 16.7251C6.81832 17.0994 6.29107 17.3314 5.7085 17.3315H4.2915C3.09583 17.3315 2.12651 16.3621 2.12646 15.1665V4.83346C2.12646 3.63776 3.09581 2.66842 4.2915 2.66842H5.7085C6.29062 2.6685 6.8184 2.89905 7.20752 3.27291C7.5967 2.89857 8.12587 2.66842 8.7085 2.66842H10.1255C10.6837 2.66859 11.1908 2.8819 11.5747 3.22896C11.879 2.92154 12.2775 2.70138 12.7358 2.62056L14.1313 2.37447ZM4.2915 3.99849C3.83035 3.99849 3.45654 4.3723 3.45654 4.83346V15.1665C3.45659 15.6276 3.83037 16.0014 4.2915 16.0014H5.7085C6.16948 16.0012 6.54341 15.6275 6.54346 15.1665V4.83346C6.54346 4.37241 6.1695 3.99867 5.7085 3.99849H4.2915ZM8.7085 3.99849C8.24734 3.99849 7.87354 4.3723 7.87354 4.83346V15.1665C7.87358 15.6276 8.24736 16.0014 8.7085 16.0014H10.1255C10.5863 16.0011 10.9604 15.6274 10.9604 15.1665V4.97896C10.9502 4.88209 10.9432 4.78602 10.9458 4.69088C10.878 4.29801 10.5376 3.99883 10.1255 3.99849H8.7085ZM15.3296 4.36178C15.2495 3.90773 14.8159 3.60416 14.3618 3.68404L12.9663 3.93014C12.5919 3.99628 12.3196 4.30259 12.2808 4.66256C12.2852 4.71899 12.2905 4.77589 12.2905 4.83346V4.90279L14.0835 15.0737C14.1636 15.5278 14.5971 15.8315 15.0513 15.7514L16.4468 15.5053C16.9006 15.425 17.2036 14.9915 17.1235 14.5376L15.3296 4.36178Z\" fill=\"currentColor\"/>",
    "builtin:images": "<path d=\"M8.95794 8.50151C9.7853 8.50151 10.4567 9.17226 10.457 9.99956C10.457 10.8271 9.78545 11.4986 8.95794 11.4986C8.13064 11.4983 7.45989 10.8269 7.45989 9.99956C7.46013 9.17241 8.13079 8.50175 8.95794 8.50151Z\" fill=\"currentColor\"/> <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M6.97356 3.95073C7.20937 2.27472 8.75937 1.1068 10.4355 1.34233L16.4101 2.18217C18.0862 2.41792 19.2541 3.96793 19.0185 5.64409L18.1786 11.6187C17.9429 13.2945 16.3936 14.4613 14.7177 14.2261L13.7802 14.0943L13.8095 14.3003C14.0449 15.9764 12.878 17.5265 11.2021 17.7623L5.22747 18.6011C3.55135 18.8367 2.00136 17.6697 1.76556 15.9937L0.925712 10.0191C0.690149 8.34297 1.85809 6.79299 3.53411 6.55717L6.6679 6.11577L6.97356 3.95073ZM6.45696 13.4781C5.86813 13.0344 5.02959 13.1519 4.58587 13.7408L3.07317 15.7476L3.08196 15.8082C3.21543 16.7568 4.09325 17.4179 5.04192 17.2847L10.4911 16.5181L6.45696 13.4781ZM9.69427 7.03471L3.71966 7.87358C2.77088 8.00692 2.10994 8.88478 2.24309 9.83354L2.81145 13.8843L3.52434 12.94C4.41016 11.765 6.08147 11.5301 7.25677 12.4156L11.9775 15.9732C12.3629 15.6007 12.5733 15.0575 12.4931 14.4859L11.6533 8.51128C11.5199 7.56254 10.643 6.90155 9.69427 7.03471ZM10.2509 2.65971C9.30204 2.52636 8.42434 3.18743 8.29095 4.13628L8.03899 5.92339L9.50872 5.71733C11.1849 5.4819 12.7351 6.65051 12.9706 8.32671L13.5878 12.7242L14.9023 12.9097C15.851 13.0429 16.7278 12.3818 16.8613 11.4332L17.7011 5.45854C17.8343 4.50986 17.1732 3.63205 16.2245 3.49858L10.2509 2.65971Z\" fill=\"currentColor\"/>",
    "builtin:skills": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M10.5208 1.88086C15.7221 1.88086 18.3078 5.71869 18.3079 9.1875C18.3079 10.6634 17.6928 12.1653 16.6019 13.0332C16.0469 13.4746 15.3655 13.7517 14.598 13.7559C13.9313 13.7594 13.2416 13.5557 12.5511 13.1377C11.9219 13.6395 11.2034 13.9685 10.4534 14.0312C9.535 14.108 8.63654 13.7825 7.91047 13.0283L7.87238 12.9883C7.85039 12.965 7.8186 12.9309 7.77863 12.8887C7.69832 12.8039 7.58559 12.6849 7.45637 12.5488C7.19751 12.2762 6.87183 11.9348 6.60578 11.6572L6.54719 11.5889C6.27521 11.2405 6.30519 10.736 6.6302 10.4229L6.84504 10.2158L6.10383 9.44629C5.84919 9.18175 5.857 8.76058 6.12141 8.50586C6.38599 8.25118 6.80713 8.2589 7.06184 8.52344L7.80305 9.29297L9.59406 7.56836L8.85383 6.7998C8.59913 6.5352 8.60778 6.11407 8.87238 5.85938C9.13699 5.60473 9.55813 5.61237 9.81281 5.87695L10.553 6.64648L10.7747 6.43359C11.1235 6.098 11.6792 6.10952 12.013 6.45996L13.3167 7.8291C14.0599 8.59431 14.3531 9.50484 14.2337 10.4219C14.1535 11.0377 13.8891 11.6205 13.5052 12.1455C13.9126 12.3481 14.2758 12.4274 14.5911 12.4258C15.0278 12.4233 15.4257 12.269 15.7737 11.9922C16.4894 11.4229 16.9779 10.3387 16.9779 9.1875C16.9777 6.36405 14.9015 3.21094 10.5208 3.21094C6.8614 3.21118 3.69922 6.00766 3.45344 9.52734C3.17857 13.4658 5.9647 16.7887 10.2064 16.7891C11.8181 16.7891 13.4105 16.3859 14.5159 15.5303C14.8063 15.3055 15.2247 15.3591 15.4495 15.6494C15.6741 15.9398 15.6207 16.3573 15.3304 16.582C13.9169 17.6762 12.0013 18.1191 10.2064 18.1191C5.1481 18.1188 1.80089 14.096 2.12629 9.43457C2.42465 5.16205 6.22034 1.8811 10.5208 1.88086ZM7.8802 11.0654C8.06588 11.2601 8.25662 11.4605 8.42023 11.6328C8.54982 11.7693 8.66289 11.8886 8.74348 11.9736C8.78365 12.016 8.81607 12.0508 8.8382 12.0742L8.87238 12.1094C9.33016 12.583 9.83897 12.7472 10.3431 12.7051C10.8683 12.661 11.4519 12.3855 11.9945 11.8633C12.543 11.3352 12.848 10.7668 12.9154 10.25C12.9794 9.75778 12.8385 9.24516 12.3587 8.75293L12.3538 8.74707L11.3665 7.70996L7.8802 11.0654Z\" fill=\"currentColor\"/>"
  };
  NATIVE_OUTLINE_ICONS["builtin:customize"] = NATIVE_OUTLINE_ICONS["builtin:skills"];
  const NATIVE_PAGE_LABELS = [
    "新建任务",
    "new task",
    "new chat",
    "拉取请求",
    "pull requests",
    "站点",
    "sites",
    "已安排",
    "scheduled",
    "插件",
    "plugins",
  ];
  const PROJECT_SECTION_LABELS = ["projects", "项目"];
  const TASK_SECTION_LABELS = ["tasks", "任务", "chats", "对话"];

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let page = null;
  let frame = null;
  let dragRegion = null;
  let noDragLeft = null;
  let noDragRight = null;
  let status = null;
  let frameOrigin = "";
  let frameReady = false;
  let frameCspBlocked = false;
  let frameReadyWaiters = new Set();
  let hostRequests = new Map();
  let hostRequestSequence = 0;
  let observer = null;
  let reattachTimer = null;
  let lastFocusedElement = null;
  let hostContextSnapshot = null;
  let lastPostedHostContextFrame = null;
  let lastPostedHostContextSignature = "";
  let currentCodexUser = null;
  let openGeneration = 0;
  let pendingThreadCreation = null;
  let lastNativeThreadId = "";
  let active = false;
  let destroyed = false;
  const hiddenAutomationPlaceholders = new Set();

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeThreadId(value) {
    return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  }

  function resolveTaskboardUrl() {
    const configured = typeof window.__CODEX_TASKBOARD_URL_V2__ === "string"
      ? window.__CODEX_TASKBOARD_URL_V2__.trim()
      : typeof window.__CODEX_TASKBOARD_URL__ === "string"
        ? window.__CODEX_TASKBOARD_URL__.trim()
        : "";
    try {
      const url = new URL(configured || DEFAULT_TASKBOARD_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported taskboard URL protocol");
      }
      if (!url.searchParams.has("host")) url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL);
    }
  }

  function isLocalTaskboardOrigin(origin) {
    try {
      const { protocol, hostname } = new URL(origin);
      return (protocol === "http:" || protocol === "https:")
        && (hostname === "127.0.0.1" || hostname === "localhost");
    } catch (_) {
      return false;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      [${AUTOMATION_PLACEHOLDER_ATTRIBUTE}="true"] {
        display: none !important;
      }
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] nav[data-app-navigation-rail] {
        visibility: visible !important;
        pointer-events: auto !important;
      }
      :root[data-codex-taskboard-open="true"] nav[data-app-navigation-rail] button[data-selected]:not(#${ENTRY_ID}):not(:hover) {
        color: var(--button-text-color) !important;
      }
      :root[data-codex-taskboard-open="true"] nav[data-app-navigation-rail] button[data-selected]:not(#${ENTRY_ID}):not(:hover)::before {
        opacity: 0 !important;
      }
      [${NATIVE_ICON_ATTRIBUTE}="outline"],
      #${ENTRY_ID} [data-taskboard-icon="filled"] {
        display: none;
      }
      :root[data-codex-taskboard-open="true"] [data-selected] [${NATIVE_ICON_ATTRIBUTE}="original"],
      #${ENTRY_ID}[data-selected] [data-taskboard-icon="outline"] {
        display: none;
      }
      :root[data-codex-taskboard-open="true"] [data-selected] [${NATIVE_ICON_ATTRIBUTE}="outline"],
      #${ENTRY_ID}[data-selected] [data-taskboard-icon="filled"] {
        display: initial;
      }
      #${PAGE_ID} {
        position: absolute;
        top: var(--app-shell-titlebar-height, 0px);
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 1;
        border-radius: var(--radius-xl-base, 0px);
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${FRAME_ID}[hidden] {
        display: none !important;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${NO_DRAG_LEFT_ID},
      #${NO_DRAG_RIGHT_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: no-drag;
      }
      #${DRAG_REGION_ID}[hidden],
      #${NO_DRAG_LEFT_ID}[hidden],
      #${NO_DRAG_RIGHT_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} button {
        margin-top: 10px;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 7px;
        padding: 5px 10px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const text = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(text);
  }

  function findReferenceButton() {
    const rail = document.querySelector("nav[data-app-navigation-rail]");
    const explore = Array.from(rail?.querySelectorAll("button") || []).find((button) =>
      button.getAttribute(OWNED_ATTRIBUTE) !== "true"
      && buttonMatches(button.querySelector(".sr-only"), ["探索", "explore"]));
    if (explore) return explore;
    const railButton = document.querySelector('aside button[data-sidebar-destination="builtin:customize"]')
      || document.querySelector('aside button[data-sidebar-destination="builtin:library"]');
    if (railButton) return railButton;
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin?.parentElement) return plugin;

    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  function replaceEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `
      <g data-taskboard-icon="outline">
        <rect x="3.5" y="4" width="17" height="16" rx="2.5"></rect>
        <path d="M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5"></path>
      </g>
      <path data-taskboard-icon="filled" fill="currentColor" stroke="none" fill-rule="evenodd"
        d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm-1 3v12a1 1 0 0 0 1 1h2V5H6a1 1 0 0 0-1 1Zm8 1v2h5V7h-5Zm0 4v2h5v-2h-5Zm0 4v2h5v-2h-5Z"></path>
    `;
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-haspopup");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.removeAttribute("data-sidebar-destination");
    button.removeAttribute("data-selected");
    button.removeAttribute("data-suppress-active-style");
    button.removeAttribute("aria-current");
    button.dataset.codexTaskboardMenu = reference.hasAttribute("data-sidebar-destination") ? "rail" : "list";
    button.setAttribute("aria-label", "打开Loop看板");
    button.setAttribute("title", "Loop看板");
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    button.querySelectorAll("span.absolute.end-0.top-0").forEach((node) => node.remove());
    const label = button.querySelector(".text-fade-truncate, .sr-only")
      || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    if (label) label.textContent = "Loop看板";
    else button.textContent = "Loop看板";
    replaceEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTaskboard();
    });
    return button;
  }

  function syncEntryState() {
    if (!entry) return;
    if (entry.hasAttribute("data-selected") !== active) entry.toggleAttribute("data-selected", active);
    if (active && entry.getAttribute("aria-current") !== "page") {
      entry.setAttribute("aria-current", "page");
    } else if (!active && entry.hasAttribute("aria-current")) {
      entry.removeAttribute("aria-current");
    }
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    const menuKind = reference.hasAttribute("data-sidebar-destination") ? "rail" : "list";
    if (entry && entry.dataset.codexTaskboardMenu !== menuKind) {
      entry.remove();
      entry = null;
    }
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    syncEntryState();
  }

  function findPageHost() {
    const direct = document.querySelector(".app-shell-main-content-frame");
    if (direct?.closest?.("[data-app-shell-main-content-layout]")) return direct;

    const viewport = document.querySelector("[data-app-shell-main-content-layout]");
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    // 新版标题栏覆盖在内容区上方，挂载位置应以内容容器而非全局标题栏为准。
    return Array.from(viewport.children).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8
        && rect.height >= viewportRect.height * 0.7
        && rect.top >= viewportRect.top - 1;
    }) || null;
  }

  function findPageMount() {
    const frameHost = findPageHost();
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]");
    const surface = viewport?.closest("[data-app-shell-workspace-row]") || viewport?.parentElement;
    if (!frameHost || !surface || !viewport.closest("main")) return null;
    const rail = surface.querySelector("nav[data-app-navigation-rail]");
    return { frameHost, surface, rail };
  }

  function syncNativeRailIcons() {
    document.querySelectorAll('nav[data-app-navigation-rail] [data-sidebar-destination]')
      .forEach((button) => {
        const body = NATIVE_OUTLINE_ICONS[button.getAttribute("data-sidebar-destination")];
        const original = button.querySelector(`svg:not([${OWNED_ATTRIBUTE}])`);
        if (!body || !original || original.hasAttribute(NATIVE_ICON_ATTRIBUTE)) return;
        button.querySelector(`[${NATIVE_ICON_ATTRIBUTE}="outline"]`)?.remove();
        original.setAttribute(NATIVE_ICON_ATTRIBUTE, "original");
        const outline = original.cloneNode(false);
        outline.setAttribute(OWNED_ATTRIBUTE, "true");
        outline.setAttribute(NATIVE_ICON_ATTRIBUTE, "outline");
        outline.innerHTML = body;
        original.after(outline);
      });
  }

  function restoreNativeRailIcons() {
    document.querySelectorAll(`[${NATIVE_ICON_ATTRIBUTE}="outline"]`).forEach((node) => node.remove());
    document.querySelectorAll(`[${NATIVE_ICON_ATTRIBUTE}="original"]`)
      .forEach((node) => node.removeAttribute(NATIVE_ICON_ATTRIBUTE));
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return window.getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function threadIdFromLocation() {
    const source = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function activeThreadRow() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    return rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || null;
  }

  function readCodexProjects() {
    const seen = new Set();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .flatMap((row) => {
        const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
        const name = (
          row.getAttribute("data-app-action-sidebar-project-label")
          || row.getAttribute("aria-label")
          || ""
        ).trim();
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name }];
      });
  }

  function findProjectsSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section-heading]"))
      .find((node) => PROJECT_SECTION_LABELS.includes(normalizedLabel(
        node.getAttribute("data-app-action-sidebar-section-heading") || node.textContent,
      )))
      ?.closest("[data-app-action-sidebar-section]") || null;
  }

  function findTasksSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section]"))
      .find((section) => {
        const heading = section.querySelector("[data-app-action-sidebar-section-heading]");
        const label = heading?.getAttribute("data-app-action-sidebar-section-heading")
          || heading?.textContent
          || section.textContent;
        return TASK_SECTION_LABELS.includes(normalizedLabel(label));
      }) || null;
  }

  async function captureHostContext() {
    const user = await readCodexUser();
    let projects = readCodexProjects();
    let section = findProjectsSection();
    const sectionDeadline = Date.now() + 1_200;
    while (!section && Date.now() < sectionDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    const tasksSection = findTasksSection();
    const expandedSections = [section, tasksSection].filter((candidate) => (
      candidate?.getAttribute("data-app-action-sidebar-section-collapsed") === "true"
    ));
    expandedSections.forEach((candidate) => (
      candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click()
    ));
    if (expandedSections.length > 0) {
      const deadline = Date.now() + 1_200;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        projects = readCodexProjects();
      } while ((projects.length === 0 || !activeThreadRow()) && Date.now() < deadline);
    }
    const context = { ...readHostContext(projects), user };
    expandedSections.forEach((candidate) => {
      if (candidate.isConnected && candidate.getAttribute("data-app-action-sidebar-section-collapsed") === "false") {
        candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
      }
    });
    return context;
  }

  function workspaceFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("workspace") || url.searchParams.get("cwd") || "";
    } catch (_) {
      return "";
    }
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const mount = findPageMount();
    const surfaceLeft = mount?.rail?.getBoundingClientRect().right ?? mount?.surface.getBoundingClientRect().left;
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(
      document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'),
    );
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (!trigger || !nativeSidebarCollapsed()) return;
    trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function userIdFromName(name) {
    const slug = name.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96);
    if (slug) return slug;
    let hash = 2166136261;
    for (const character of name) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `codex-user-${(hash >>> 0).toString(36)}`;
  }

  function codexProfileMenu(profileButton) {
    const menuId = profileButton.getAttribute("aria-controls");
    const menu = menuId ? document.getElementById(menuId) : null;
    return menu?.getAttribute("role") === "menu"
      && menu.getAttribute("aria-labelledby") === profileButton.id
      ? menu
      : null;
  }

  function readCodexProfileIdentity(profileButton) {
    const menu = codexProfileMenu(profileButton);
    for (const row of menu?.querySelectorAll('[role="menuitem"], [role="separator"]') ?? []) {
      if (row.getAttribute("role") === "separator") break;
      if (row.hasAttribute("aria-label")) continue;
      const content = row.querySelector("[data-menu-row-content]");
      // The name is separate from both the leading avatar and the optional plan.
      const name = content?.querySelector(
        ":scope > div.flex.min-w-0.flex-1.flex-col > span.min-w-0.truncate:first-child,"
        + ":scope > span.flex-1.min-w-0",
      )?.textContent?.replace(/\s+/g, " ").trim();
      if (!name) continue;
      const avatar = content.querySelector(":scope > span img") || profileButton.querySelector("img");
      return { name, avatarUrl: avatar?.currentSrc || avatar?.src || null };
    }
    return null;
  }

  async function normalizeCodexAvatar(avatarUrl) {
    if (!avatarUrl?.startsWith("data:")) return avatarUrl;
    const image = new Image();
    image.src = avatarUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    // Keep inline avatars within the existing 2048-character actor header budget.
    for (const size of [48, 32, 16]) {
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(
        image,
        (image.naturalWidth - sourceSize) / 2, (image.naturalHeight - sourceSize) / 2,
        sourceSize, sourceSize, 0, 0, size, size,
      );
      const result = canvas.toDataURL("image/webp", 0.8);
      if (result.startsWith("data:image/webp;base64,") && result.length <= 2048) return result;
    }
    throw new Error("无法将 Codex 头像缩小至身份请求头限制");
  }

  async function readCodexUser(userId) {
    const profileButton = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => (
      normalizedLabel(button.getAttribute("aria-label")).includes("profile")
      || normalizedLabel(button.getAttribute("aria-label")).includes("个人资料")
    ));
    if (!profileButton) return null;
    const directName = profileButton.textContent?.replace(/\s+/g, " ").trim();
    if (directName && !profileButton.hasAttribute("aria-controls")) {
      const avatar = profileButton.querySelector("img");
      return { type: "user", id: userId || userIdFromName(directName), name: directName,
        avatarUrl: await normalizeCodexAvatar(avatar?.currentSrc || avatar?.src || null) };
    }
    const openedMenu = profileButton.getAttribute("aria-expanded") !== "true";
    let identity;
    try {
      if (openedMenu) {
        // Radix opens on ArrowDown; HTMLElement.click() does not run its trigger handler.
        profileButton.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true,
        }));
      }
      const deadline = Date.now() + 1_200;
      do {
        identity = readCodexProfileIdentity(profileButton);
        if (identity) break;
        await new Promise((resolve) => window.setTimeout(resolve, 40));
      } while (Date.now() < deadline);
      if (!identity) throw new Error("无法读取 Codex 公开显示名称");
    } finally {
      const menu = openedMenu ? codexProfileMenu(profileButton) : null;
      if (menu) {
        menu.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", code: "Escape", bubbles: true, cancelable: true,
        }));
        const deadline = Date.now() + 1_200;
        while (profileButton.getAttribute("aria-expanded") === "true" && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 40));
        }
        if (profileButton.getAttribute("aria-expanded") === "true") {
          throw new Error("无法关闭 Codex 个人资料菜单");
        }
      }
    }
    return {
      type: "user",
      id: userId || userIdFromName(identity.name),
      name: identity.name,
      avatarUrl: await normalizeCodexAvatar(identity.avatarUrl),
    };
  }

  function readHostContext(projects = readCodexProjects()) {
    const row = activeThreadRow();
    const activeThreadId = normalizeThreadId(row?.getAttribute("data-app-action-sidebar-thread-id"));
    if (activeThreadId) lastNativeThreadId = activeThreadId;
    const threadId = activeThreadId || lastNativeThreadId || normalizeThreadId(threadIdFromLocation());
    const projectList = row?.closest?.("[data-app-action-sidebar-project-list-id]");
    const projectRow = row?.closest?.("[data-app-action-sidebar-project-id]")
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute("data-app-action-sidebar-project-list-id")
      || projectRow?.getAttribute("data-app-action-sidebar-project-id")
      || "";
    const workspacePath = workspaceFromLocation();
    const payload = {
      theme: currentTheme(),
      projects,
      user: currentCodexUser ?? undefined,
      titlebarLeftInset: titlebarLeftInset(),
      sidebarCollapsed: nativeSidebarCollapsed(),
    };
    if (workspacePath) payload.workspacePath = workspacePath;
    if (projectId) payload.projectId = projectId;
    if (threadId) payload.threadId = threadId;
    return payload;
  }

  function postToFrame(message) {
    if (!frame?.contentWindow || !frameOrigin) return;
    frame.contentWindow.postMessage(message, frameOrigin);
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function postHostContext(force = false) {
    if (!frame) return;
    const liveContext = readHostContext();
    const payload = hostContextSnapshot
      ? {
          ...hostContextSnapshot,
          ...liveContext,
          projects: liveContext.projects.length > 0
            ? liveContext.projects
            : hostContextSnapshot.projects,
        }
      : liveContext;
    const signature = JSON.stringify(payload);
    if (
      !force
      && frame === lastPostedHostContextFrame
      && signature === lastPostedHostContextSignature
    ) return;
    lastPostedHostContextFrame = frame;
    lastPostedHostContextSignature = signature;
    postToFrame({ type: "taskboard:host-context", payload });
    postToFrame({ type: "taskboard:theme", theme: payload.theme });
  }

  function findThreadRow(threadId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)) || null;
  }

  function routeForThread(threadId) {
    return `/local/${encodeURIComponent(threadId)}`;
  }

  async function openThread(threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) return;
    const normalizedThreadId = normalizeThreadId(threadId);
    lastNativeThreadId = normalizedThreadId;
    const row = findThreadRow(normalizedThreadId);
    closeTaskboard(false);

    if (row?.isConnected) {
      row.click?.();
      return;
    }

    try {
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: routeForThread(normalizedThreadId),
      });
    } catch (_) {}
  }

  function projectRowById(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => row.getAttribute("data-app-action-sidebar-project-id") === projectId.trim()) || null;
  }

  function projectRowByLabel(label) {
    if (typeof label !== "string" || !label.trim()) return null;
    const expected = normalizedLabel(label);
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => normalizedLabel(row.getAttribute("data-app-action-sidebar-project-label")) === expected) || null;
  }

  async function ensureProjectRows() {
    let section = findProjectsSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexProjects().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  async function waitForPreparedComposer(identifier, skillPath) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const editor = document.querySelector('[data-codex-composer="true"][contenteditable="true"]');
      if (editor && editor.getClientRects().length > 0) {
        const containsIdentifier = normalizedLabel(editor.textContent).includes(normalizedLabel(identifier));
        const skillMention = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((mention) => (
            mention.getAttribute("skill-mention-name") === "code-loop-board"
            && mention.getAttribute("skill-mention-path") === skillPath
          ));
        if (containsIdentifier && skillMention) return editor;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error("Codex 对话输入框没有生成 code-loop-board Skill 引用");
  }

  async function createThreadForTask(payload) {
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const skillName = typeof payload?.skillName === "string" ? payload.skillName.trim() : "";
    const skillDisplayName = typeof payload?.skillDisplayName === "string"
      ? payload.skillDisplayName.trim()
      : "";
    const skillPath = typeof payload?.skillPath === "string" ? payload.skillPath.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    if (
      !taskId
      || !identifier
      || !instruction
      || !skillName
      || !skillDisplayName
      || !skillPath
      || pendingThreadCreation
    ) return;
    pendingThreadCreation = taskId;
    try {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error("当前 Codex 版本没有提供原生对话导航能力");
      }

      if (workspacePath) {
        await bridge.sendMessageFromView({
          type: "electron-set-active-workspace-root",
          root: workspacePath,
        });
      } else {
        await ensureProjectRows();
        const snapshotProjectId = hostContextSnapshot?.projectId || "";
        const requestedProjectId = typeof payload.codexProjectId === "string"
          ? payload.codexProjectId.trim()
          : "";
        const row = projectRowByLabel(payload.workspaceLabel)
          || projectRowById(requestedProjectId)
          || projectRowById(snapshotProjectId)
          || projectRowByLabel(payload.projectName);
        if (row?.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
          row.click?.();
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        const selectProject = row?.querySelector("[data-app-action-sidebar-select-project]");
        selectProject?.click?.();
        if (selectProject) await new Promise((resolve) => window.setTimeout(resolve, 120));
      }

      closeTaskboard(false);
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: "/",
        state: {
          focusComposerNonce: Date.now(),
        },
      });
      await requestHostTaskComposerPrefill({
        instruction,
        skillDisplayName,
        skillName,
        skillPath,
      });
      await waitForPreparedComposer(identifier, skillPath);
      postToFrame({ type: "taskboard:thread-prepared", payload: { taskId } });
    } catch (error) {
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: { taskId, error: error instanceof Error ? error.message : "无法创建 Codex 对话" },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  function buildAutomationHostPayload(payload) {
    return {
      requestId: payload.requestId,
      operation: payload.operation,
      taskboardProjectId: payload.taskboardProjectId,
      codexProjectId: payload.codexProjectId,
      projectName: payload.projectName,
      workspacePath: payload.workspacePath,
      skillPath: payload.skillPath,
      ...(payload.automationId === undefined ? {} : { automationId: payload.automationId }),
      ...(payload.slotAutomationIds === undefined ? {} : { slotAutomationIds: payload.slotAutomationIds }),
      enabledByUser: payload.enabledByUser,
      quotaAware: payload.quotaAware,
      concurrencyLimit: payload.concurrencyLimit,
      intervalMinutes: payload.intervalMinutes,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
      ...(payload.boardConfig === undefined ? {} : { boardConfig: payload.boardConfig }),
    };
  }

  async function handleAutomationRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    if (!isLocalTaskboardOrigin(frameOrigin)) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: { requestId, ok: false, error: "仅本地Loop看板可用" },
      });
      return;
    }
    try {
      const response = await requestHost(
        "automation",
        buildAutomationHostPayload(payload),
      );
      postToFrame({
        type: "taskboard:automation-response",
        payload: response.error
          ? { requestId, ok: false, error: response.error }
          : {
              requestId,
              ok: true,
              item: response.item,
              items: response.items,
              quota: response.quota,
              policy: response.policy,
              slotAutomationIds: response.slotAutomationIds,
              summary: response.summary,
            },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "Codex 自动任务操作失败",
        },
      });
    }
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "taskboard:ready") {
      frameReady = true;
        frameReadyWaiters.forEach(({ resolve, timer }) => {
          window.clearTimeout(timer);
          resolve();
        });
        frameReadyWaiters.clear();
        if (active) showFrame();
        postHostContext(true);
        return;
    }
    if (message.type === "taskboard:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (message.type === "taskboard:open-thread") {
      void openThread(message.payload?.threadId);
      return;
    }
    if (message.type === "taskboard:expand-sidebar") {
      expandNativeSidebar();
      return;
    }
    if (message.type === "taskboard:automation-request") {
      void handleAutomationRequest(message.payload);
      return;
    }
    if (message.type === "taskboard:create-thread") void createThreadForTask(message.payload);
  }

  function updateDragRegion(payload) {
    if (!dragRegion || !noDragLeft || !noDragRight) return;
    const [x, y, width, height] = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      dragRegion.hidden = true;
      noDragLeft.hidden = true;
      noDragRight.hidden = true;
      return;
    }
    const left = Math.max(0, x);
    const right = left + width;
    dragRegion.style.left = `${left}px`;
    dragRegion.style.top = `${Math.max(0, y)}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${height}px`;
    noDragLeft.style.left = "0";
    noDragLeft.style.top = `${Math.max(0, y)}px`;
    noDragLeft.style.width = `${left}px`;
    noDragLeft.style.height = `${height}px`;
    noDragRight.style.left = `${right}px`;
    noDragRight.style.top = `${Math.max(0, y)}px`;
    noDragRight.style.right = "0";
    noDragRight.style.height = `${height}px`;
    dragRegion.hidden = false;
    noDragLeft.hidden = left <= 0;
    noDragRight.hidden = right >= page.clientWidth;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "Loop看板");

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);

    noDragLeft = document.createElement("div");
    noDragLeft.id = NO_DRAG_LEFT_ID;
    noDragLeft.hidden = true;
    noDragLeft.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragLeft.setAttribute("aria-hidden", "true");
    section.appendChild(noDragLeft);

    noDragRight = document.createElement("div");
    noDragRight.id = NO_DRAG_RIGHT_ID;
    noDragRight.hidden = true;
    noDragRight.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragRight.setAttribute("aria-hidden", "true");
    section.appendChild(noDragRight);
    return section;
  }

  function showLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode("正在启动Loop看板…"));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
  }

  function showLoadError(message) {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新启动";
    retry.addEventListener("click", openTaskboard, { once: true });
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function cancelFrameReadyWaiters(error) {
    frameReadyWaiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(error);
    });
    frameReadyWaiters.clear();
  }

  function waitForFrameReady() {
    if (frameReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          frameReadyWaiters.delete(waiter);
          reject(new Error("Loop看板页面加载超时"));
        }, FRAME_READY_TIMEOUT_MS),
      };
      frameReadyWaiters.add(waiter);
    });
  }

  function loadTaskboardFrame(cacheBust = false) {
    cancelFrameReadyWaiters(new Error("Loop看板正在重新加载"));
    frame?.remove();
    frame = null;
    frameReady = false;
    frameCspBlocked = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;

    const taskboardUrl = resolveTaskboardUrl();
    if (cacheBust) {
      taskboardUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    frameOrigin = taskboardUrl.origin;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.src = taskboardUrl.href;
    nextFrame.title = "Loop看板";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.addEventListener("load", postHostContext);
    frame = nextFrame;
    page.appendChild(nextFrame);
  }

  function reloadFrame() {
    if (!frame) return false;
    const generation = ++openGeneration;
    if (active) showLoading();
    loadTaskboardFrame(true);
    if (active) {
      void waitForFrameReady()
        .then(() => {
          if (!active || generation !== openGeneration) return;
          showFrame();
          postHostContext();
        })
        .catch((error) => {
          if (!active || generation !== openGeneration) return;
          showLoadError(error.message);
        });
    }
    return true;
  }

  function managedTaskboardOrigin() {
    const configured = typeof window.__CODEX_TASKBOARD_MANAGED_ORIGIN_V2__ === "string"
      ? window.__CODEX_TASKBOARD_MANAGED_ORIGIN_V2__.trim()
      : typeof window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ === "string"
        ? window.__CODEX_TASKBOARD_MANAGED_ORIGIN__.trim()
        : "";
    try {
      return new URL(configured || DEFAULT_TASKBOARD_URL).origin;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL).origin;
    }
  }

  function hasLiveHostBinding() {
    const heartbeat = Number(window[HOST_HEARTBEAT_NAME]);
    return typeof window[HOST_BINDING_NAME] === "function"
      && Number.isFinite(heartbeat)
      && Date.now() - heartbeat <= HOST_HEARTBEAT_MAX_AGE_MS;
  }

  function requestHost(action, payload = {}) {
    const binding = window[HOST_BINDING_NAME];
    if (!hasLiveHostBinding()) {
      return Promise.reject(new Error("Taskboard 启动器未运行，无法操作 Codex 对话输入框"));
    }

    const id = `${Date.now().toString(36)}-${(++hostRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        hostRequests.delete(id);
        reject(new Error("Loop看板启动器没有响应"));
      }, HOST_REQUEST_TIMEOUT_MS);
      hostRequests.set(id, { resolve, reject, timeout });
      try {
        binding(JSON.stringify({ ...payload, id, action }));
      } catch (error) {
        window.clearTimeout(timeout);
        hostRequests.delete(id);
        reject(error);
      }
    });
  }

  function requestHostEnsure(taskboardUrl) {
    if (taskboardUrl.origin !== managedTaskboardOrigin() || !hasLiveHostBinding()) {
      return Promise.resolve({ managed: false, restarted: false });
    }
    return requestHost("ensure");
  }

  function requestHostTaskComposerPrefill({
    instruction,
    skillDisplayName,
    skillName,
    skillPath,
  }) {
    return requestHost("prefill-task-composer", {
      instruction,
      skillDisplayName,
      skillName,
      skillPath,
    });
  }

  function frameMatchesTaskboardUrl(taskboardUrl) {
    if (!frame) return false;
    try {
      const loadedUrl = new URL(frame.getAttribute("src") || frame.src);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(taskboardUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function onHostResponse(response) {
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = hostRequests.get(response.id);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    hostRequests.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "Loop看板服务启动失败"));
  }

  async function prepareTaskboard(generation) {
    const taskboardUrl = resolveTaskboardUrl();
    showLoading();

    try {
      const [result, context] = await Promise.all([
        requestHostEnsure(taskboardUrl),
        captureHostContext(),
      ]);
      if (!active || generation !== openGeneration) return;
      currentCodexUser = context.user;
      hostContextSnapshot = context;
      if (!frameReady || result.restarted || !frameMatchesTaskboardUrl(taskboardUrl)) {
        showLoading();
        loadTaskboardFrame();
        await waitForFrameReady();
      }
      if (!active || generation !== openGeneration) return;
      showFrame();
      postHostContext();
    } catch (error) {
      if (!active || generation !== openGeneration) return;
      const bindingAvailable = hasLiveHostBinding();
      showLoadError(bindingAvailable
        ? error.message
        : "Loop看板服务未就绪。请保持 Loop看板启动器运行后重试。");
    }
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function mountActivePage() {
    if (!active) return;
    if (!page) page = createPage();
    const mount = findPageMount();
    if (!mount) return;
    const { surface, rail } = mount;

    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
    }
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    page.style.left = `${rail ? rail.getBoundingClientRect().right - surface.getBoundingClientRect().left : 0}px`;
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    syncNativeRailIcons();
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-taskboard-open", "true");
  }

  function closeTaskboard(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    openGeneration += 1;
    active = false;
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeRailIcons();
    document.documentElement.removeAttribute("data-codex-taskboard-open");
    syncEntryState();
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    hostContextSnapshot = null;
  }

  function openTaskboard() {
    if (destroyed) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = null;
    }
    const generation = ++openGeneration;
    active = true;
    ensureEntry();
    mountActivePage();
    syncEntryState();
    void prepareTaskboard(generation);
  }

  function isNativePageNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest(`#${ENTRY_ID}`)) return false;
    if (clickable.matches("aside [data-sidebar-destination], nav[data-app-navigation-rail] [data-sidebar-destination]")) return true;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    if (buttonMatches(clickable, NATIVE_PAGE_LABELS)) return true;
    return Boolean(clickable.closest(
      "[data-app-action-sidebar-thread-id],"
      + "[data-app-action-sidebar-project-row],"
      + "[data-app-action-sidebar-project-id]",
    ));
  }

  function onDocumentClick(event) {
    const threadRow = event.target?.closest?.("[data-app-action-sidebar-thread-id]");
    const clickedThreadId = normalizeThreadId(threadRow?.getAttribute?.("data-app-action-sidebar-thread-id"));
    if (clickedThreadId) lastNativeThreadId = clickedThreadId;
    if (!active || !isNativePageNavigation(event.target)) return;
    const destination = event.target.closest('nav[data-app-navigation-rail] [data-sidebar-destination]');
    if (destination?.getAttribute("aria-current") === "page") {
      event.preventDefault();
      event.stopPropagation();
    }
    closeTaskboard(false);
  }

  function syncAutomationPromptPlaceholders() {
    const placeholders = new Set();
    for (const conversation of document.querySelectorAll('[data-thread-find-target="conversation"]')) {
      const bubbles = Array.from(conversation.querySelectorAll("[data-user-message-bubble]"));
      const hasAutomationMessage = bubbles.some((bubble) => {
        if (!bubble.closest("[data-content-search-unit-key]")) return false;
        const text = bubble.textContent || "";
        return /^\s*Automation:/.test(text)
          && text.includes("Automation ID:")
          && /\$code-loop-board\s+e-taskboard\b/.test(text);
      });
      for (const bubble of bubbles) {
        const group = bubble.parentElement;
        // Codex's inbox fallback lives outside turns; actual user messages must remain untouched.
        if (group?.parentElement !== conversation) continue;
        if (!/^\s*\$code-loop-board\s+e-taskboard\b/.test(bubble.textContent || "")) continue;
        // Keep a verified placeholder hidden when the real turn scrolls out of the virtualized DOM.
        if (!hasAutomationMessage && !hiddenAutomationPlaceholders.has(group)) continue;
        placeholders.add(group);
        if (!hiddenAutomationPlaceholders.has(group)) {
          group.setAttribute(AUTOMATION_PLACEHOLDER_ATTRIBUTE, "true");
          hiddenAutomationPlaceholders.add(group);
        }
      }
    }
    for (const node of hiddenAutomationPlaceholders) {
      if (placeholders.has(node)) continue;
      node.removeAttribute(AUTOMATION_PLACEHOLDER_ATTRIBUTE);
      hiddenAutomationPlaceholders.delete(node);
    }
  }

  function scheduleRefresh() {
    if (destroyed || reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      ensureEntry();
      mountActivePage();
      postHostContext();
      syncAutomationPromptPlaceholders();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    ensureEntry();
    mountActivePage();
    postHostContext();
    syncAutomationPromptPlaceholders();
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    syncAutomationPromptPlaceholders();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "data-theme",
        "data-color-theme",
        "data-app-action-sidebar-thread-active",
        "aria-label",
        "aria-current",
        "data-selected",
      ],
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (reattachTimer !== null) window.clearTimeout(reattachTimer);
    reattachTimer = null;
    observer?.disconnect();
    observer = null;
    cancelFrameReadyWaiters(new Error("Loop看板已关闭"));
    hostRequests.forEach(({ reject, timeout }) => {
      window.clearTimeout(timeout);
      reject(new Error("Loop看板已关闭"));
    });
    hostRequests.clear();
    pendingThreadCreation = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("securitypolicyviolation", onSecurityPolicyViolation);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    closeTaskboard(false);
    hiddenAutomationPlaceholders.forEach((node) => node.removeAttribute(AUTOMATION_PLACEHOLDER_ATTRIBUTE));
    hiddenAutomationPlaceholders.clear();
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    page = null;
    frame = null;
    dragRegion = null;
    noDragLeft = null;
    noDragRight = null;
    status = null;
    frameOrigin = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  function onNativeRouteChange() {
    if (active) closeTaskboard(false);
  }

  function onSecurityPolicyViolation(event) {
    if (event.disposition !== "enforce" || !["frame-src", "child-src"].includes(event.effectiveDirective)) return;
    if (event.blockedURI === frameOrigin || event.blockedURI?.startsWith(`${frameOrigin}/`)) {
      frameCspBlocked = true;
    }
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    get startupStatus() {
      return { ready: frameReady && page?.hidden === false && frame?.hidden === false, cspBlocked: frameCspBlocked };
    },
    refresh,
    reloadFrame,
    open: openTaskboard,
    close: closeTaskboard,
    destroy,
    hostResponse: onHostResponse,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("securitypolicyviolation", onSecurityPolicyViolation);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
