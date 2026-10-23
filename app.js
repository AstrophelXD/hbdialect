const SVG_NS = "http://www.w3.org/2000/svg";

const VIEW_TITLES = {
  home: "湖北方言数字图谱",
  overview: "概述｜湖北方言数字图谱",
  phonology: "语音｜湖北方言数字图谱",
  vocabulary: "语汇｜湖北方言数字图谱",
  grammar: "语法｜湖北方言数字图谱",
  appendix: "附录｜湖北方言数字图谱",
};

const DEFAULT_MAP_PALETTE_ID = "hubei-administrative-pastel-v1";
const DEFAULT_COLOR_REFERENCE = Object.freeze({ family: 8, color_index: 2 });
const DATASET_SOURCES = Object.freeze([
  Object.freeze({ id: "ben", url: "./data/extracted/ben.json" }),
  Object.freeze({ id: "shuijiao", url: "./data/extracted/shuijiao.json" }),
]);

// Presets are intentionally defined in code. Dataset JSON may select a family
// and a 1-based color index, but it cannot inject arbitrary CSS colors.
const MAP_COLOR_PRESETS = Object.freeze({
  "hubei-administrative-pastel-v1": Object.freeze({
    name: "湖北行政图柔彩",
    families: Object.freeze({
      1: Object.freeze(["#e8e4f0", "#d2cce3", "#b8afd2", "#9b8cbe"]),
      2: Object.freeze(["#f7e5ec", "#f0cbd9", "#e5afc4", "#d58eaa"]),
      3: Object.freeze(["#e1f0ea", "#c7e3d8", "#a8d2c1", "#83bda7"]),
      4: Object.freeze(["#e2eef3", "#c9dfe9", "#a9cadb", "#82afc6"]),
      5: Object.freeze(["#f7f0d5", "#eee2af", "#e1cf83", "#cfb75c"]),
      6: Object.freeze(["#f8e8d2", "#f2d3aa", "#e6ba7e", "#d5a05b"]),
      7: Object.freeze(["#ebefd9", "#d8e3b8", "#bed092", "#9fb56e"]),
      8: Object.freeze(["#eef0ed", "#d9deda", "#c2cbc5", "#a6b2aa"]),
    }),
  }),
});

const state = {
  geojson: null,
  boundaries: null,
  geography: null,
  dataset: null,
  datasets: new Map(),
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
  detailPrefecture: document.querySelector("#detail-prefecture"),
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

function resolveMapColor(reference, paletteId = DEFAULT_MAP_PALETTE_ID) {
  const palette = MAP_COLOR_PRESETS[paletteId] ?? MAP_COLOR_PRESETS[DEFAULT_MAP_PALETTE_ID];
  const family = palette.families[reference?.family];
  const colorIndex = Number(reference?.color_index);
  if (!family || !Number.isInteger(colorIndex) || colorIndex < 1 || colorIndex > family.length) {
    const fallbackFamily = palette.families[DEFAULT_COLOR_REFERENCE.family];
    return fallbackFamily[DEFAULT_COLOR_REFERENCE.color_index - 1];
  }
  return family[colorIndex - 1];
}

function buildCategories(dataset) {
  const usedForms = new Set(
    dataset.records.flatMap((record) => splitForms(record.raw_value)),
  );
  const visualization = dataset.visualization ?? {};
  const paletteId = visualization.palette_id ?? DEFAULT_MAP_PALETTE_ID;
  const seenForms = new Set();
  const configuredCategories = (visualization.color_assignments ?? []).map(
    (assignment, index) => {
      const rawValue = String(assignment.value ?? "").trim();
      if (!rawValue || seenForms.has(rawValue)) {
        throw new Error(`Invalid or duplicate color assignment: ${rawValue || "(empty)"}`);
      }
      seenForms.add(rawValue);
      return {
        id: `form-${index}`,
        label: assignment.label ?? rawValue,
        rawValue,
        family: assignment.family,
        colorIndex: assignment.color_index,
        color: resolveMapColor(assignment, paletteId),
      };
    },
  );
  const activeCategories = configuredCategories.filter((category) =>
    usedForms.has(category.rawValue),
  );
  const hasUnassignedForms = [...usedForms].some((form) => !seenForms.has(form));
  const fallbackReference = visualization.fallback ?? DEFAULT_COLOR_REFERENCE;

  if (hasUnassignedForms) {
    activeCategories.push({
      id: "other",
      label: fallbackReference.label ?? "其他",
      family: fallbackReference.family,
      colorIndex: fallbackReference.color_index,
      color: resolveMapColor(fallbackReference, paletteId),
    });
  }
  return activeCategories;
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

function lineGeometryToPath(geometry, project) {
  if (!geometry) return "";
  const lineToPath = (line) =>
    line
      .map((point, index) => {
        const [x, y] = project(point);
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join("");

  if (geometry.type === "LineString") return lineToPath(geometry.coordinates);
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.map(lineToPath).join("");
  }
  return "";
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

function displayAreaForFeature(feature) {
  const properties = feature?.properties ?? {};
  const memberGbs = (properties.member_gbs ?? [properties.gb])
    .filter((gb) => gb !== null && gb !== undefined)
    .map(String);
  const mappedMembers = memberGbs
    .map((gb) => state.areaByGb.get(gb))
    .filter(Boolean);
  const memberNames = properties.member_names ?? mappedMembers.map((area) => area.name);
  const groupIds = properties.group_ids ?? mappedMembers.map((area) => area.group_id);

  return {
    id: String(properties.display_id ?? properties.gb ?? ""),
    name: String(properties.display_name ?? mappedMembers[0]?.name ?? ""),
    level: String(properties.display_level ?? "county"),
    prefectureName: String(properties.prefecture_name ?? ""),
    memberGbs,
    memberNames: memberNames.map(String),
    groupIds: uniqueValues(groupIds.map(String)),
  };
}

function aggregateRecords(records) {
  const forms = uniqueValues(records.flatMap((record) => splitForms(record.raw_value)));
  const variants = uniqueValues(records.flatMap((record) => record.variants ?? []));
  const sourcePages = records.map(
    (record) =>
      `${record.historical_name}：PDF ${record.pdf_page} / 印刷页 ${record.printed_page}`,
  );

  return {
    raw_value: forms.join("/"),
    variants,
    pageLabel:
      records.length === 1
        ? `PDF ${records[0].pdf_page} / 印刷页 ${records[0].printed_page}`
        : sourcePages.join("；"),
  };
}

function featureContext(index) {
  const feature = state.features[index];
  if (!feature) return null;
  const area = displayAreaForFeature(feature);
  const records = area.groupIds
    .map((groupId) => state.recordByGroupId.get(groupId))
    .filter(Boolean);
  if (
    !area.id ||
    !area.name ||
    !area.prefectureName ||
    !records.length ||
    records.length !== area.groupIds.length
  ) {
    return null;
  }
  return { feature, area, records, record: aggregateRecords(records) };
}

function renderLegend() {
  elements.legend.replaceChildren();

  state.categories.forEach((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "legend-button";
    button.dataset.classification = category.id;
    button.dataset.colorFamily = String(category.family);
    button.dataset.colorIndex = String(category.colorIndex);
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
  state.features.forEach((_, index) => {
    const rawValue = featureContext(index)?.record.raw_value;
    const forms = splitForms(rawValue);
    if (forms.length < 2 || patternIds.has(rawValue)) return;

    const stripeCategories = forms.map((form) => classifyForm(form));
    const patternId = `form-stripes-${patternIds.size}`;
    const stripeWidth = 10;
    const pattern = makeSvgElement("pattern", {
      id: patternId,
      width: String(stripeWidth * stripeCategories.length),
      height: "12",
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(28)",
    });
    stripeCategories.forEach((category, stripeIndex) => {
      pattern.append(
        makeSvgElement("rect", {
          class: "pattern-stripe",
          x: String(stripeIndex * stripeWidth),
          y: "0",
          width: String(stripeWidth),
          height: "12",
          fill: category.color,
          "data-classification": category.id,
        }),
      );
    });
    defs.append(pattern);
    patternIds.set(rawValue, patternId);
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

  const boundariesLayer = makeSvgElement("g", {
    class: "admin-boundaries-layer",
    "aria-hidden": "true",
  });
  const boundaryByLevel = new Map(
    (state.boundaries?.features ?? []).map((feature) => [feature.properties?.level, feature]),
  );
  ["county", "city", "province"].forEach((level) => {
    const feature = boundaryByLevel.get(level);
    if (!feature) return;
    boundariesLayer.append(
      makeSvgElement("path", {
        d: lineGeometryToPath(feature.geometry, project),
        class: `admin-boundary admin-boundary--${level}`,
        fill: "none",
      }),
    );
  });

  elements.map.append(defs, regionsLayer, boundariesLayer);
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
  elements.map.querySelectorAll(".pattern-stripe").forEach((stripe) => {
    stripe.classList.toggle(
      "is-muted",
      state.legendFilter !== null && stripe.dataset.classification !== state.legendFilter,
    );
  });
}

function resetMapView() {
  const hadLegendFilter = state.legendFilter !== null;
  const hadMapHighlight = state.highlightedIndex >= 0;
  if (!hadLegendFilter && !hadMapHighlight) return;

  state.legendFilter = null;
  state.highlightedIndex = -1;
  renderLegend();
  updateMapSelection();
  applyLegendFilter();
  hideTooltip();
  elements.announcement.textContent = `已恢复全部区域显示，右侧仍显示${featureContext(state.selectedIndex)?.area.name ?? "当前区划"}。`;
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

  elements.detailPrefecture.textContent = area.prefectureName;
  elements.detailPlace.textContent = area.name;
  elements.detailForm.textContent = record.raw_value;
  elements.detailConcept.textContent = state.dataset.concept?.mandarin_label ?? "当前词目";
  elements.detailPage.textContent = record.pageLabel;

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
    const area = displayAreaForFeature(feature);
    return [area.name, ...area.memberNames].some(
      (name) => normalizeSearchText(name) === normalized,
    );
  });
  if (exactArea >= 0) return exactArea;

  return state.features.findIndex((feature) => {
    const area = displayAreaForFeature(feature);
    return [area.name, ...area.memberNames].some((name) =>
      normalizeSearchText(name).includes(normalized),
    );
  });
}

function initializeSearch() {
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = elements.searchInput.value.trim();

    if (!query) {
      elements.searchMessage.textContent = "请输入显示区域或现行区县名称。";
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
  const coveredGbs = state.features.flatMap(
    (feature) => displayAreaForFeature(feature).memberGbs,
  );
  const missingAreas = coveredGbs.filter((gb) => !state.areaByGb.has(gb));
  const duplicateAreas = coveredGbs.filter((gb, index) => coveredGbs.indexOf(gb) !== index);
  const uncoveredAreas = state.geography.areas.filter(
    (area) => !coveredGbs.includes(String(area.gb)),
  );
  const missingRecords = state.geography.groups.filter(
    (group) => !state.recordByGroupId.has(group.id),
  );
  const invalidFeatures = state.features.filter((_, index) => !featureContext(index));
  const boundaryLevels = new Set(
    (state.boundaries?.features ?? []).map((feature) => feature.properties?.level),
  );
  const invalidBoundaryFeatures = (state.boundaries?.features ?? []).filter(
    (feature) => !["LineString", "MultiLineString"].includes(feature.geometry?.type),
  );
  const missingBoundaryLevels = ["county", "city", "province"].filter(
    (level) => !boundaryLevels.has(level),
  );
  if (
    missingAreas.length ||
    duplicateAreas.length ||
    uncoveredAreas.length ||
    missingRecords.length ||
    invalidFeatures.length ||
    invalidBoundaryFeatures.length ||
    missingBoundaryLevels.length
  ) {
    throw new Error(
      `Data coverage error: ${missingAreas.length} unknown, ${duplicateAreas.length} duplicate, ` +
        `${uncoveredAreas.length} uncovered, ${missingRecords.length} records missing, ` +
        `${invalidFeatures.length} invalid display features, ` +
        `${invalidBoundaryFeatures.length} invalid boundaries, ` +
        `${missingBoundaryLevels.length} boundary levels missing`,
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

function loadDatasetFont(dataset) {
  if (!document.fonts?.load) return;
  const glyphs = [
    dataset.concept?.mandarin_label ?? "",
    ...dataset.records.flatMap((record) => [record.raw_value, record.historical_name]),
  ].join("");
  void document.fonts
    .load('600 1em "Source Han Serif CN Variable"', glyphs)
    .catch(() => undefined);
}

function activateDataset(conceptId, options = {}) {
  const { announce = false } = options;
  const dataset = state.datasets.get(conceptId);
  if (!dataset) throw new Error(`Unknown concept dataset: ${conceptId}`);

  state.dataset = dataset;
  state.categories = buildCategories(dataset);
  state.legendFilter = null;
  buildIndexes();
  validateCoverage();

  if (state.selectedIndex < 0 || state.selectedIndex >= state.features.length) {
    state.selectedIndex = 0;
  }
  state.highlightedIndex = state.selectedIndex;

  const conceptLabel = dataset.concept?.mandarin_label ?? "当前词目";
  elements.conceptSelect.value = conceptId;
  elements.map.setAttribute(
    "aria-label",
    `湖北省${conceptLabel}词形分布地图。使用方向键切换显示区域，按回车查看。`,
  );
  elements.searchMessage.textContent = "";

  renderLegend();
  renderMap();
  updateDetail(state.selectedIndex);
  loadDatasetFont(dataset);

  if (announce) {
    const areaName = featureContext(state.selectedIndex)?.area.name ?? "当前区域";
    elements.announcement.textContent = `已切换到词目${conceptLabel}，地图和右侧说明已更新，当前显示${areaName}。`;
  }
}

function initializeConceptSelector() {
  elements.conceptSelect.addEventListener("change", () => {
    try {
      activateDataset(elements.conceptSelect.value, { announce: true });
    } catch (error) {
      showMapError(error);
    }
  });
}

async function loadData() {
  const commonUrls = [
    "./data/display_areas_simplified.geojson",
    "./data/admin_boundary.geojson",
    "./data/geography.json",
  ];
  const urls = [...commonUrls, ...DATASET_SOURCES.map((source) => source.url)];
  const responses = await Promise.all(urls.map((url) => fetch(url)));
  responses.forEach((response, index) => {
    if (!response.ok) throw new Error(`Failed to load ${urls[index]}: ${response.status}`);
  });
  const payloads = await Promise.all(responses.map((response) => response.json()));
  [state.geojson, state.boundaries, state.geography] = payloads.slice(0, commonUrls.length);
  const datasets = payloads.slice(commonUrls.length);
  state.datasets = new Map(
    datasets.map((dataset, index) => {
      const expectedId = DATASET_SOURCES[index].id;
      const actualId = dataset.concept?.id;
      if (actualId !== expectedId) {
        throw new Error(`Concept dataset mismatch: expected ${expectedId}, got ${actualId}`);
      }
      return [actualId, dataset];
    }),
  );
  state.features = state.geojson.features ?? [];
  state.areaByGb = new Map(state.geography.areas.map((area) => [String(area.gb), area]));

  elements.conceptSelect.replaceChildren();
  DATASET_SOURCES.forEach(({ id }) => {
    const dataset = state.datasets.get(id);
    const option = document.createElement("option");
    option.value = id;
    option.textContent = dataset.concept?.mandarin_label ?? id;
    elements.conceptSelect.append(option);
  });

  const customAreaCount = state.features.filter(
    (feature) => feature.properties?.display_level === "custom",
  ).length;
  elements.mapStatus.textContent = `${state.features.length} 个显示区域（${customAreaCount} 个合并市区）`;

  const initialIndex = state.features.findIndex((feature) =>
    displayAreaForFeature(feature).memberNames.includes("武昌区"),
  );
  state.selectedIndex = initialIndex >= 0 ? initialIndex : 0;
  activateDataset(DATASET_SOURCES[0].id);
}

async function initialize() {
  initializeRouting();
  initializeSearch();
  initializeConceptSelector();
  elements.mapCanvas.addEventListener("click", (event) => {
    if (event.target === elements.mapCanvas || event.target === elements.map) {
      resetMapView();
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
