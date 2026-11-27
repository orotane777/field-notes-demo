const colors = [["#ff453a", "빨강"], ["#ffd65a", "노랑"], ["#ffffff", "흰색"]];
const hints = {
  ellipse: "사진 위에서 손가락을 끌어 원을 그리세요.",
  arrow: "화살표를 시작할 곳에서 가리킬 곳까지 끌어주세요.",
  text: "사진에서 글자를 넣을 곳을 누르세요.",
};
const icons = {
  cancel: '<path d="m6 6 12 12M18 6 6 18"/>',
  undo: '<path d="m8 4-5 5 5 5M4 9h9a7 7 0 0 1 0 14" transform="translate(0 -1)"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.6" ry="7.1"/>',
  arrow: '<path d="M4 20 20 4M10 4h10v10"/>',
  text: '<path d="M4 7V4h16v3M12 4v16m-4 0h8"/>',
};
const icon = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function drawText(ctx, mark, width, height) {
  const short = Math.min(width, height), margin = short * .015;
  let size = short * .052;
  function wrap() {
    ctx.font = `650 ${size}px Roboto, "Malgun Gothic", system-ui, sans-serif`;
    const lines = [];
    for (const paragraph of mark.text.split("\n")) {
      let line = "";
      for (const character of paragraph) {
        if (line && ctx.measureText(line + character).width > width - 2 * margin) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
      lines.push(line);
    }
    return lines;
  }
  let lines = wrap();
  if (lines.length * size * 1.3 > height - 2 * margin) {
    size = (height - 2 * margin) / (lines.length * 1.3);
    lines = wrap();
  }
  let longest = 0;
  for (const line of lines) longest = Math.max(longest, ctx.measureText(line).width);
  const x = clamp(mark.x * width, margin, width - longest - margin);
  const y = clamp(mark.y * height, margin, height - lines.length * size * 1.3 - margin);
  ctx.textBaseline = "top";
  ctx.lineWidth = size * .145;
  ctx.strokeStyle = "rgba(0,0,0,.85)";
  ctx.fillStyle = mark.color;
  lines.forEach((line, i) => {
    ctx.strokeText(line, x, y + i * size * 1.3);
    ctx.fillText(line, x, y + i * size * 1.3);
  });
}

function drawMark(ctx, mark, width, height) {
  ctx.lineCap = ctx.lineJoin = "round";
  if (mark.type === "text") {
    drawText(ctx, mark, width, height);
    return;
  }
  const x1 = mark.x1 * width, y1 = mark.y1 * height, x2 = mark.x2 * width, y2 = mark.y2 * height;
  const short = Math.min(width, height);
  ctx.beginPath();
  if (mark.type === "ellipse") {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, 2 * Math.PI);
  } else if (mark.type === "arrow") {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const tip = Math.min(Math.hypot(x2 - x1, y2 - y1) * .42, short * .073);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.moveTo(x2 - tip * Math.cos(angle - .5), y2 - tip * Math.sin(angle - .5));
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - tip * Math.cos(angle + .5), y2 - tip * Math.sin(angle + .5));
  } else return;
  ctx.lineWidth = short * .013;
  ctx.strokeStyle = "rgba(0,0,0,.58)";
  ctx.stroke();
  ctx.lineWidth = short * .008;
  ctx.strokeStyle = mark.color;
  ctx.stroke();
}

async function flatten(image, marks) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  try {
    const ctx = canvas.getContext("2d", {alpha: false});
    ctx.drawImage(image, 0, 0);
    for (const mark of marks) drawMark(ctx, mark, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .95));
    if (!blob?.size) throw new Error("사진을 만들 수 없습니다.");
    return blob;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export function openPhotoMarkup({source, marks = [], onSave, parent = document.body}) {
  const panel = document.createElement("dialog");
  panel.className = "photo-markup";
  panel.setAttribute("aria-label", "사진에 표시");
  panel.innerHTML = `
    <header class="markup-header">
      <button type="button" class="markup-icon" data-markup-cancel aria-label="편집 취소" title="편집 취소">${icon("cancel")}</button>
      <h2>사진에 표시</h2>
      <button type="button" class="markup-icon" data-markup-undo aria-label="실행 취소" title="실행 취소">${icon("undo")}</button>
      <button type="button" class="markup-save" data-markup-save disabled>저장</button>
    </header>
    <div class="markup-stage">
      <div class="markup-picture" hidden>
        <img alt="표시할 촬영 사진" draggable="false">
        <canvas data-markup-canvas aria-label="사진 표시 영역"></canvas>
      </div>
    </div>
    <p class="markup-hint" data-markup-hint role="status">사진을 여는 중입니다.</p>
    <div class="markup-writing" hidden>
      <textarea data-markup-text rows="2" aria-label="사진에 넣을 글자" placeholder="사진에 넣을 글자"></textarea>
      <button type="button" data-markup-text-add>넣기</button>
    </div>
    <div class="markup-toolbar">
      <div class="markup-tools" role="group" aria-label="표시 도구">
        ${[["ellipse","원"], ["arrow","화살표"], ["text","글자"]].map(([key, label]) =>
          `<button type="button" data-markup-tool="${key}" aria-pressed="false">${icon(key)}<span>${label}</span></button>`).join("")}
      </div>
      <div class="markup-colors" role="group" aria-label="표시 색상">
        ${colors.map(([value, label]) => `<button type="button" data-markup-color="${value}" aria-label="${label}" aria-pressed="false"><i style="background:${value}"></i></button>`).join("")}
      </div>
    </div>`;
  parent.append(panel);
  panel.showModal();
  const find = selector => panel.querySelector(selector);
  const picture = find(".markup-picture"), image = find("img"), canvas = find("[data-markup-canvas]");
  const writing = find(".markup-writing"), input = find("[data-markup-text]"), hint = find("[data-markup-hint]");
  const save = find("[data-markup-save]"), undo = find("[data-markup-undo]"), cancel = find("[data-markup-cancel]");
  const toolButtons = panel.querySelectorAll("[data-markup-tool]");
  const colorButtons = panel.querySelectorAll("[data-markup-color]");
  const history = marks.slice();
  let tool = "ellipse", color = colors[0][0], activePointer = null, stroke = null, textPoint = null;
  let dirtyText = false, ready = false, saving = false, didSave = false, frame = 0;

  function paint() {
    frame = 0;
    if (!ready || !panel.open) return;
    const rect = canvas.getBoundingClientRect(), scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    for (const mark of history) drawMark(ctx, mark, width, height);
    if (stroke) drawMark(ctx, stroke, width, height);
    if (textPoint && dirtyText) drawMark(ctx, {...textPoint, type:"text", color, text:input.value}, width, height);
  }
  function repaint() { if (!frame) frame = requestAnimationFrame(paint); }
  function changed() {
    return dirtyText || history.length !== marks.length || history.some((mark, i) => mark !== marks[i]);
  }
  function buttons() {
    save.disabled = !ready || saving || !changed();
    cancel.disabled = saving;
    undo.disabled = !ready || saving || (!history.length && !textPoint);
    input.disabled = saving;
    find("[data-markup-text-add]").disabled = saving || !dirtyText;
    for (const btn of toolButtons) {
      btn.disabled = saving || !ready;
      btn.setAttribute("aria-pressed", String(btn.dataset.markupTool === tool));
    }
    for (const btn of colorButtons) {
      btn.disabled = saving || !ready;
      btn.setAttribute("aria-pressed", String(btn.dataset.markupColor === color));
    }
  }
  function endText(apply) {
    if (!textPoint) return;
    if (apply && dirtyText) history.push({...textPoint, type:"text", color, text:input.value.trim()});
    textPoint = null;
    dirtyText = false;
    input.value = "";
    input.blur();
    writing.hidden = true;
    panel.classList.remove("is-writing");
    hint.textContent = hints[tool];
    repaint();
    buttons();
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {x:clamp((event.clientX - rect.left) / rect.width, 0, 1), y:clamp((event.clientY - rect.top) / rect.height, 0, 1)};
  }
  canvas.onpointerdown = event => {
    if (!ready || saving || event.button !== 0 || activePointer !== null || !event.isPrimary) return;
    const p = point(event);
    activePointer = event.pointerId;
    canvas.setPointerCapture(activePointer);
    if (tool !== "text") stroke = {type:tool, color, x1:p.x, y1:p.y, x2:p.x, y2:p.y};
    hint.textContent = hints[tool];
  };
  canvas.onpointermove = event => {
    if (event.pointerId !== activePointer || !stroke) return;
    const p = point(event);
    stroke.x2 = p.x; stroke.y2 = p.y;
    repaint();
  };
  function cancelStroke() {
    activePointer = null;
    stroke = null;
    repaint();
  }
  canvas.onpointercancel = canvas.onlostpointercapture = event => {
    if (event.pointerId === activePointer) cancelStroke();
  };
  canvas.onpointerup = event => {
    if (event.pointerId !== activePointer) return;
    const p = point(event);
    activePointer = null;
    if (stroke) {
      stroke.x2 = p.x; stroke.y2 = p.y;
      const rect = canvas.getBoundingClientRect();
      const dx = Math.abs(stroke.x2 - stroke.x1) * rect.width, dy = Math.abs(stroke.y2 - stroke.y1) * rect.height;
      if (stroke.type === "ellipse" ? Math.min(dx, dy) >= 3 : Math.hypot(dx, dy) >= 5) history.push(stroke);
      stroke = null;
    } else if (tool === "text") {
      textPoint = p;
      writing.hidden = false;
      panel.classList.add("is-writing");
      hint.textContent = "글자를 입력하고 넣기를 누르세요.";
      input.focus({preventScroll:true});
    }
    repaint();
    buttons();
  };
  input.oninput = () => { dirtyText = Boolean(input.value.trim()); repaint(); buttons(); };
  find("[data-markup-text-add]").onclick = () => endText(true);
  for (const btn of toolButtons) btn.onclick = () => {
    endText(true); cancelStroke(); tool = btn.dataset.markupTool;
    hint.textContent = hints[tool]; buttons();
  };
  for (const btn of colorButtons) btn.onclick = () => { color = btn.dataset.markupColor; repaint(); buttons(); };
  undo.onclick = () => {
    if (textPoint) endText(false);
    else history.pop();
    hint.textContent = hints[tool]; repaint(); buttons();
  };
  function back() {
    if (saving) return;
    if (textPoint) endText(false);
    else if (stroke) cancelStroke();
    else panel.close();
  }
  cancel.onclick = () => { if (!saving) panel.close(); };
  panel.oncancel = event => { event.preventDefault(); event.stopPropagation(); back(); };
  panel.onkeydown = event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    back();
  };
  save.onclick = async () => {
    if (saving || !ready) return;
    endText(true);
    if (!changed()) { panel.close(); return; }
    saving = true;
    buttons();
    hint.textContent = "저장 중…";
    try {
      const blob = history.length ? await flatten(image, history) : source;
      await onSave({blob, marks:history.slice()});
      didSave = true;
      panel.close();
    } catch (error) {
      if (error?.name === "QuotaExceededError") hint.textContent = "폰의 저장 공간을 확보한 뒤 다시 저장해 주세요.";
      else hint.textContent = error?.name === "Error" && error.message ? error.message : "사진 표시를 저장하지 못했습니다. 다시 저장해 주세요.";
      saving = false;
      buttons();
    }
  };
  const viewport = window.visualViewport;
  function fitViewport() {
    panel.style.setProperty("--markup-height", (viewport?.height ?? window.innerHeight) + "px");
    panel.style.setProperty("--markup-top", (viewport?.offsetTop ?? 0) + "px");
    repaint();
  }
  const resize = new ResizeObserver(repaint);
  resize.observe(picture);
  viewport?.addEventListener("resize", fitViewport);
  viewport?.addEventListener("scroll", fitViewport);
  fitViewport();
  const url = URL.createObjectURL(source);
  image.onload = () => {
    ready = true;
    picture.style.setProperty("--markup-ratio", image.naturalWidth / image.naturalHeight);
    picture.hidden = false;
    hint.textContent = hints[tool]; repaint(); buttons();
  };
  image.onerror = () => { hint.textContent = "이 사진을 열 수 없습니다."; };
  buttons();
  image.src = url;
  return new Promise(resolve => panel.addEventListener("close", () => {
    resize.disconnect();
    viewport?.removeEventListener("resize", fitViewport);
    viewport?.removeEventListener("scroll", fitViewport);
    cancelAnimationFrame(frame);
    image.onload = image.onerror = null;
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
    panel.remove();
    resolve(didSave);
  }, {once:true}));
}
