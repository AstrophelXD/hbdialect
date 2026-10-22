const SVG_NS = "http://www.w3.org/2000/svg";

const VIEW_TITLES = {
  home: "湖北方言数字图谱",
  overview: "概述｜湖北方言数字图谱",
  phonology: "语音｜湖北方言数字图谱",
  vocabulary: "语汇｜湖北方言数字图谱",
  grammar: "语法｜湖北方言数字图谱",
  appendix: "附录｜湖北方言数字图谱",
};

const MAP_COLORS = ["#b8d7e6", "#c4d2cb", "#bbd8b2", "#d6d58e", "#d8ddd8"];

const state = {
  geojson: null,
  geography: null,
  dataset: null,
  features: [],
  paths: [],
  areaByGb: new Map(),
  recordByGroupId: new Map(),
  categories: [],
  selectedIndex: -1,
  highlightedIndex: -1,
  legendFilter: null,
};

const elements = {
  navLinks: [...document.querySelectorAll("[data-view-link]")],
  viewPanels: [...document.querySelectorAll("[data-view-panel]")],
  map: document.querySelector("#hubei-map"),
  mapCanvas: document.querySelector("#map-canvas"),
  mapTooltip: document.querySelector("#map-tooltip"),
  mapStatus: document.querySelector("#map-status"),
  legend: document.querySelector("#map-legend"),
  conceptSelect: document.querySelector("#concept-select"),
  searchForm: document.querySelector("#place-search-form"),
  searchInput: document.querySelector("#place-search-input"),
  searchMessage: document.querySelector("#search-message"),
  detailPlace: document.querySelector("#detail-place"),
  detailForm: document.querySelector("#detail-form"),
  detailVariants: document.querySelector("#detail-variants"),
  detailConcept: document.querySelector("#detail-concept"),
  detailPage: document.querySelector("#detail-page"),
  announcement: document.querySelector("#selection-announcement"),
};

function splitForms(rawValue) {
  return String(rawValue)
    .split("/")
    .map((form) => form.trim())
    .filter(Boolean);
}

function classifyForm(form) {
  return (
    state.categories.find((category) => category.rawValue === form) ??
    state.categories.find((category) => category.id === "other")
  );
}

function classificationsFor(rawValue) {
  return [...new Set(splitForms(rawValue).map((form) => classifyForm(form).id))];
}

function buildCategories(records) {
  const counts = new Map();
  records.forEach((record) => {
    if (!record.raw_value.includes("/")) {
      counts.set(record.raw_value, (counts.get(record.raw_value) ?? 0) + 1);
    }
  });

  const primaryForms = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, 3);

  return [
    ...primaryForms.map(([rawValue], index) => ({
      id: `form-${index}`,
      label: rawValue,
      rawValue,
      color: MAP_COLORS[index],
    })),
    { id: "other", label: "其他", color: MAP_COLORS[4] },
  ];
}

function makeSvgElement(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function walkCoordinates(coordinates, callback) {
  if (!Array.isArray(coordinates)) return;
  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === "number" &&
    typeof coordinates[1] === "number"
  ) {
    callback(coordinates);
    return;
  }
  coordinates.forEach((item) => walkCoordinates(item, callback));
}

function createProjection(features, width = 900, height = 650, padding = 34) {
  let minLongitude = Infinity;
  let maxLongitude = -Infinity;
  let minLatitude = Infinity;
  let maxLatitude = -Infinity;

  features.forEach((feature) => {
    walkCoordinates(feature.geometry?.coordinates, ([longitude, latitude]) => {
      minLongitude = Math.min(minLongitude, longitude);
      maxLongitude = Math.max(maxLongitude, longitude);
      minLatitude = Math.min(minLatitude, latitude);
      maxLatitude = Math.max(maxLatitude, latitude);
    });
  });

  const scale = Math.min(
    (width - padding * 2) / (maxLongitude - minLongitude),
    (height - padding * 2) / (maxLatitude - minLatitude),
  );
  const projectedWidth = (maxLongitude - minLongitude) * scale;
  const projectedHeight = (maxLatitude - minLatitude) * scale;
  const offsetX = (width - projectedWidth) / 2;
  const offsetY = (height - projectedHeight) / 2;

  return ([longitude, latitude]) => [
    offsetX + (longitude - minLongitude) * scale,
    offsetY + (maxLatitude - latitude) * scale,
  ];
}

function ringToPath(ring, project) {
  return `${ring
    .map((point, index) => {
      const [x, y] = project(point);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join("")}Z`;
}

function geometryToPath(geometry, project) {
  if (!geometry) return "";
  if (geometry.type === "Polygon") {
    return geometry.coordinates.map((ring) => ringToPath(ring, project)).join("");
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .flatMap((polygon) => polygon.map((ring) => ringToPath(ring, project)))
      .join("");
  }
  return "";
}

function featureContext(index) {
  const feature = state.features[index];
  if (!feature) return null;
  const area = state.areaByGb.get(String(feature.properties?.gb ?? ""));
  if (!area) return null;
  const record = state.recordByGroupId.get(area.group_id);
  if (!record) return null;
  return { feature, area, record };
}

function renderLegend() {
  elements.legend.replaceChildren();

  state.categories.forEach((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "legend-button";
    button.dataset.classification = category.id;
    button.setAttribute("aria-pressed", state.legendFilter === category.id ? "true" : "false");
    button.setAttribute(
      "aria-label",
      `${category.label}${state.legendFilter === category.id ? "，已筛选" : ""}`,
    );

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = category.color;
    swatch.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = category.label;

    button.append(swatch, label);
    button.addEventListener("click", () => {
      state.legendFilter = state.legendFilter === category.id ? null : category.id;
      renderLegend();
      applyLegendFilter();
    });

    elements.legend.append(button);
  });
}

function renderMap() {
  elements.map.replaceChildren();
  const project = createProjection(state.features);
  state.paths = state.features.map((feature) => geometryToPath(feature.geometry, project));

  const defs = makeSvgElement("defs");
  const patternIds = new Map();
  state.dataset.records.forEach((record) => {
    const forms = splitForms(record.raw_value);
    if (forms.length < 2 || patternIds.has(record.raw_value)) return;

    const colors = forms.map((form) => classifyForm(form).color);
    const patternId = `form-stripes-${patternIds.size}`;
    const stripeWidth = 10;
    const pattern = makeSvgElement("pattern", {
      id: patternId,
      width: String(stripeWidth * colors.length),
      height: "12",
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(28)",
    });
    colors.forEach((color, stripeIndex) => {
      pattern.append(
        makeSvgElement("rect", {
          x: String(stripeIndex * stripeWidth),
          y: "0",
          width: String(stripeWidth),
          height: "12",
          fill: color,
        }),
      );
    });
    defs.append(pattern);
    patternIds.set(record.raw_value, patternId);
  });

  const regionsLayer = makeSvgElement("g", { class: "regions-layer" });

  state.features.forEach((feature, index) => {
    const context = featureContext(index);
    if (!context) return;
    const { area, record } = context;
    const forms = splitForms(record.raw_value);
    const categories = classificationsFor(record.raw_value);
    const fill =
      forms.length > 1
        ? `url(#${patternIds.get(record.raw_value)})`
        : classifyForm(forms[0]).color;
    const isSelected = index === state.highlightedIndex;
    const path = makeSvgElement("path", {
      d: state.paths[index],
      class: `region-shape${isSelected ? " is-selected" : ""}`,
      fill,
      "fill-rule": "evenodd",
      role: "button",
      tabindex: index === state.selectedIndex ? "0" : "-1",
      "aria-label": `${area.name}，对应词形${record.raw_value}`,
      "data-index": String(index),
      "data-classifications": categories.join(" "),
    });

    path.addEventListener("click", () => selectFeature(index, { announce: true }));
    path.addEventListener("pointerenter", (event) => showTooltip(event, index));
    path.addEventListener("pointermove", moveTooltip);
    path.addEventListener("pointerleave", hideTooltip);
    path.addEventListener("focus", () => selectFeature(index));
    path.addEventListener("keydown", (event) => handleMapKeydown(event, index));
    regionsLayer.append(path);
  });

  elements.map.append(defs, regionsLayer);
  applyLegendFilter();
}

function updateMapSelection() {
  elements.map.querySelectorAll(".region-shape").forEach((path) => {
    const index = Number(path.dataset.index);
    const selected = index === state.highlightedIndex;
    path.classList.toggle("is-selected", selected);
    path.setAttribute("tabindex", index === state.selectedIndex ? "0" : "-1");
  });
}

function applyLegendFilter() {
  elements.map.querySelectorAll(".region-shape").forEach((path) => {
    const classifications = path.dataset.classifications?.split(" ") ?? [];
    path.classList.toggle(
      "is-muted",
      state.legendFilter !== null && !classifications.includes(state.legendFilter),
    );
  });
}

function clearMapHighlight() {
  if (state.highlightedIndex < 0) return;
  state.highlightedIndex = -1;
  updateMapSelection();
  hideTooltip();
  elements.announcement.textContent = `已取消地图高亮，右侧仍显示${featureContext(state.selectedIndex)?.area.name ?? "当前区划"}。`;
}

function showTooltip(event, index) {
  const context = featureContext(index);
  if (!context) return;
  const { area, record } = context;
  elements.mapTooltip.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = area.name;
  const summary = document.createElement("span");
  summary.textContent = `对应词形：${record.raw_value}`;
  elements.mapTooltip.append(title, summary);
  elements.mapTooltip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  if (elements.mapTooltip.hidden) return;
  const canvas = elements.mapCanvas.getBoundingClientRect();
  const tooltip = elements.mapTooltip.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, event.clientX - canvas.left + 14),
    Math.max(8, canvas.width - tooltip.width - 8),
  );
  const top = Math.min(
    Math.max(8, event.clientY - canvas.top + 14),
    Math.max(8, canvas.height - tooltip.height - 8),
  );
  elements.mapTooltip.style.left = `${left}px`;
  elements.mapTooltip.style.top = `${top}px`;
}

function hideTooltip() {
  elements.mapTooltip.hidden = true;
}

function updateDetail(index, announce = false) {
  const context = featureContext(index);
  if (!context) return;
  const { area, record } = context;

  elements.detailPlace.textContent = area.name;
  elements.detailForm.textContent = record.raw_value;
  elements.detailConcept.textContent = state.dataset.concept?.mandarin_label ?? "当前词目";
  elements.detailPage.textContent = `PDF ${record.pdf_page} / 印刷页 ${record.printed_page}`;

  elements.detailVariants.replaceChildren();
  record.variants.forEach((variant) => {
    const chip = document.createElement("span");
    chip.className = "variant-chip";
    chip.textContent = variant;
    elements.detailVariants.append(chip);
  });

  if (announce) {
    elements.announcement.textContent = `已选择${area.name}，对应词形${record.raw_value}`;
  }
}

function selectFeature(index, options = {}) {
  const { announce = false, focus = false } = options;
  const context = featureContext(index);
  if (!context) return;
  state.selectedIndex = index;
  state.highlightedIndex = index;
  hideTooltip();
  updateMapSelection();
  updateDetail(index, announce);

  if (focus) {
    requestAnimationFrame(() => {
      elements.map.querySelector(`[data-index="${index}"]`)?.focus({ preventScroll: true });
    });
  }
}

function handleMapKeydown(event, index) {
  const stepByKey = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };

  if (event.key in stepByKey) {
    event.preventDefault();
    const nextIndex = (index + stepByKey[event.key] + state.features.length) % state.features.length;
    selectFeature(nextIndex, { announce: true, focus: true });
    return;
  }

  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : state.features.length - 1;
    selectFeature(nextIndex, { announce: true, focus: true });
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectFeature(index, { announce: true });
  }
}

function normalizeSearchText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function searchPlace(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return -1;

  const exactArea = state.features.findIndex((feature) => {
    const area = state.areaByGb.get(String(feature.properties?.gb ?? ""));
    return normalizeSearchText(area?.name) === normalized;
  });
  if (exactArea >= 0) return exactArea;

  return state.features.findIndex((_, index) => {
    const context = featureContext(index);
    return normalizeSearchText(context?.area.name).includes(normalized);
  });
}

function initializeSearch() {
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = elements.searchInput.value.trim();

    if (!query) {
      elements.searchMessage.textContent = "请输入现行区县名称。";
      elements.searchInput.focus();
      return;
    }

    const index = searchPlace(query);
    if (index < 0) {
      elements.searchMessage.textContent = `未找到“${query}”，可尝试“武昌区”。`;
      return;
    }

    const context = featureContext(index);
    elements.searchMessage.textContent = `已定位：${context.area.name}`;
    selectFeature(index, { announce: true, focus: true });
  });
}

function routeFromHash() {
  const requested = window.location.hash.replace(/^#/, "");
  return Object.hasOwn(VIEW_TITLES, requested) ? requested : "vocabulary";
}

function showView(view, options = {}) {
  const { scroll = false } = options;
  elements.viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });
  elements.navLinks.forEach((link) => {
    if (link.closest(".primary-nav")) {
      if (link.dataset.viewLink === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  });
  document.title = VIEW_TITLES[view];
  if (scroll) window.scrollTo({ top: 0, behavior: "auto" });
}

function initializeRouting() {
  const rawView = window.location.hash.replace(/^#/, "");
  if (!rawView || !Object.hasOwn(VIEW_TITLES, rawView)) {
    history.replaceState(null, "", "#vocabulary");
  }
  showView(routeFromHash());
  window.addEventListener("hashchange", () => showView(routeFromHash(), { scroll: true }));
}

function buildIndexes() {
  state.areaByGb = new Map(state.geography.areas.map((area) => [String(area.gb), area]));
  state.recordByGroupId = new Map(
    state.dataset.records.map((record) => [record.place_id, record]),
  );
}

function validateCoverage() {
  const missingAreas = state.features.filter(
    (feature) => !state.areaByGb.has(String(feature.properties?.gb ?? "")),
  );
  const missingRecords = state.geography.groups.filter(
    (group) => !state.recordByGroupId.has(group.id),
  );
  if (missingAreas.length || missingRecords.length) {
    throw new Error(
      `Data coverage error: ${missingAreas.length} areas and ${missingRecords.length} records missing`,
    );
  }
}

function showMapError(error) {
  console.error(error);
  elements.map.replaceChildren();
  const message = makeSvgElement("text", {
    class: "map-loading",
    x: "450",
    y: "320",
    "text-anchor": "middle",
  });
  message.textContent = "地图读取失败，请通过本地服务器打开此页面。";
  elements.map.append(message);
  elements.mapStatus.textContent = "地图数据未载入";
  elements.searchMessage.textContent = "请启动本地服务器后重试。";
}

async function loadData() {
  const urls = ["./hubei.geojson", "./data/geography.json", "./data/extracted/ben.json"];
  const responses = await Promise.all(urls.map((url) => fetch(url)));
  responses.forEach((response, index) => {
    if (!response.ok) throw new Error(`Failed to load ${urls[index]}: ${response.status}`);
  });
  [state.geojson, state.geography, state.dataset] = await Promise.all(
    responses.map((response) => response.json()),
  );
  state.features = state.geojson.features ?? [];
  state.categories = buildCategories(state.dataset.records);
  buildIndexes();
  validateCoverage();

  const conceptLabel = state.dataset.concept?.mandarin_label ?? "当前词目";
  const conceptId = state.dataset.concept?.id ?? "current";
  elements.conceptSelect.replaceChildren();
  const conceptOption = document.createElement("option");
  conceptOption.value = conceptId;
  conceptOption.textContent = conceptLabel;
  elements.conceptSelect.append(conceptOption);
  elements.map.setAttribute(
    "aria-label",
    `湖北省${conceptLabel}词形分布地图。使用方向键切换区划，按回车查看。`,
  );
  elements.mapStatus.textContent = `${state.features.length} 个现行县级区划`;

  if (document.fonts?.load) {
    const serifGlyphs = [
      conceptLabel,
      ...state.dataset.records.flatMap((record) => [record.raw_value, record.historical_name]),
    ].join("");
    void document.fonts
      .load('600 1em "Source Han Serif CN Variable"', serifGlyphs)
      .catch(() => undefined);
  }

  const initialIndex = state.features.findIndex(
    (feature) => state.areaByGb.get(String(feature.properties?.gb ?? ""))?.name === "武昌区",
  );
  state.selectedIndex = initialIndex >= 0 ? initialIndex : 0;
  state.highlightedIndex = state.selectedIndex;

  renderLegend();
  renderMap();
  updateDetail(state.selectedIndex);
}

async function initialize() {
  initializeRouting();
  initializeSearch();
  elements.mapCanvas.addEventListener("click", (event) => {
    if (event.target === elements.mapCanvas || event.target === elements.map) {
      clearMapHighlight();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTooltip();
  });

  try {
    await loadData();
  } catch (error) {
    showMapError(error);
  }
}

initialize();
