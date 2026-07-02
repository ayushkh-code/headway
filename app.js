(function () {
  'use strict';

  const HOURS = Array.from({ length: 19 }, (_, i) => i + 5);
  const SHIFT_LENGTHS = [4, 6, 8, 10];
  const DEBOUNCE_MS = 250;

  const PRESETS = {
    weekday: [12, 30, 55, 70, 48, 32, 28, 34, 30, 28, 34, 52, 68, 60, 38, 24, 18, 14, 8],
    weekend: [4, 8, 14, 22, 30, 38, 42, 44, 42, 38, 36, 34, 36, 40, 38, 32, 26, 18, 10],
    event: [10, 24, 40, 50, 38, 30, 28, 30, 32, 34, 40, 48, 56, 70, 95, 110, 60, 30, 14],
    hospital: [30, 65, 78, 40, 26, 22, 24, 26, 28, 48, 72, 44, 28, 24, 26, 34, 52, 74, 68],
  };

  const state = {
    demand: PRESETS.weekday.slice(),
    preset: 'weekday',
    ridesPerVehHour: 3.5,
    bufferPct: 15,
    baseWaitMin: 8,
    driverWage: 22,
    maxFleet: 40,
    shifts: [],
    required: [],
    supplied: [],
    wait: [],
    fleetCount: [],
    kpis: {},
    uncoveredHours: 0,
    baseline: null,
    disruption: null,
  };

  let debounceTimer = null;
  let dragState = null;

  const $ = (id) => document.getElementById(id);

  function hourLabel(h) {
    return h < 10 ? `0${h}:00` : `${h}:00`;
  }

  function hourIndex(h) {
    return h - 5;
  }

  function computeRequired() {
    return state.demand.map((d) =>
      Math.ceil((d / state.ridesPerVehHour) * (1 + state.bufferPct / 100))
    );
  }

  function getBreakHour(start, length) {
    if (length < 6) return null;
    return start + Math.floor(length / 2);
  }

  function shiftContribution(start, length, hour) {
    if (hour < start || hour >= start + length) return 0;
    const brk = getBreakHour(start, length);
    return brk === hour ? 0.5 : 1;
  }

  function shiftPaidHours(length) {
    return length >= 6 ? length - 0.5 : length;
  }

  function enumerateShifts() {
    const shifts = [];
    for (const len of SHIFT_LENGTHS) {
      for (let start = 5; start <= 20; start++) {
        if (start + len <= 24) {
          shifts.push({ start, length: len });
        }
      }
    }
    return shifts;
  }

  function shiftHours(start, length) {
    const hrs = [];
    for (let h = start; h < start + length; h++) hrs.push(h);
    return hrs;
  }

  function shiftValue(start, length, deficit) {
    let val = 0;
    for (const h of shiftHours(start, length)) {
      const idx = hourIndex(h);
      const contrib = shiftContribution(start, length, h);
      val += Math.min(contrib, Math.max(0, deficit[idx]));
    }
    return val;
  }

  function canAddShift(start, length, fleetCount, maxFleet) {
    for (const h of shiftHours(start, length)) {
      if (fleetCount[hourIndex(h)] + 1 > maxFleet) return false;
    }
    return true;
  }

  function applyShiftToSupplied(start, length, supplied, fleetCount) {
    for (const h of shiftHours(start, length)) {
      const idx = hourIndex(h);
      supplied[idx] += shiftContribution(start, length, h);
      fleetCount[idx] += 1;
    }
  }

  function optimizeShifts(required, maxFleet) {
    const supplied = new Array(19).fill(0);
    const fleetCount = new Array(19).fill(0);
    const deficit = required.slice();
    const shifts = [];
    const allCandidates = enumerateShifts();
    let driverNum = 1;

    while (deficit.some((d) => d > 0)) {
      let best = null;
      let bestEff = -1;

      for (const cand of allCandidates) {
        if (!canAddShift(cand.start, cand.length, fleetCount, maxFleet)) continue;
        const val = shiftValue(cand.start, cand.length, deficit);
        if (val <= 0) continue;
        const paid = shiftPaidHours(cand.length);
        const eff = val / paid;

        if (
          eff > bestEff ||
          (eff === bestEff && best && (
            cand.length < best.length ||
            (cand.length === best.length && cand.start < best.start)
          ))
        ) {
          bestEff = eff;
          best = cand;
        } else if (eff === bestEff && !best) {
          best = cand;
        }
      }

      if (!best || bestEff <= 0) break;

      const brk = getBreakHour(best.start, best.length);
      shifts.push({
        id: `D${String(driverNum).padStart(2, '0')}`,
        start: best.start,
        end: best.start + best.length,
        length: best.length,
        breakHour: brk,
        paidHours: shiftPaidHours(best.length),
      });
      driverNum++;

      for (const h of shiftHours(best.start, best.length)) {
        const idx = hourIndex(h);
        const contrib = shiftContribution(best.start, best.length, h);
        supplied[idx] += contrib;
        fleetCount[idx] += 1;
        deficit[idx] = Math.max(0, deficit[idx] - contrib);
      }
    }

    const uncoveredHours = deficit.filter((d) => d > 0).length;
    return { shifts, supplied, fleetCount, uncoveredHours };
  }

  function computeWait(supplied, required) {
    return supplied.map((s, i) => {
      const r = required[i];
      if (s >= r) return state.baseWaitMin;
      const w = state.baseWaitMin * Math.pow(r / Math.max(s, 1), 1.5);
      return Math.min(w, 45);
    });
  }

  function computeKPIs(shifts, supplied, required, wait, otHours = 0) {
    const sumRequired = required.reduce((a, b) => a + b, 0);
    const coveragePct = sumRequired > 0
      ? (required.reduce((acc, r, i) => acc + Math.min(supplied[i], r), 0) / sumRequired) * 100
      : 100;

    const peakFleet = supplied.length ? Math.max(...supplied) : 0;
    const totalVehHours = supplied.reduce((a, b) => a + b, 0);
    const idleVehHours = supplied.reduce((acc, s, i) => acc + Math.max(0, s - required[i]), 0);
    const idlePct = totalVehHours > 0 ? (idleVehHours / totalVehHours) * 100 : 0;

    const paidDriverHours = shifts.reduce((acc, sh) => acc + sh.paidHours, 0);
    const regularHours = paidDriverHours - otHours;
    const laborCost = regularHours * state.driverWage + otHours * state.driverWage * 1.5;

    const sumDemand = state.demand.reduce((a, b) => a + b, 0);
    const weightedWait = sumDemand > 0
      ? wait.reduce((acc, w, i) => acc + w * state.demand[i], 0) / sumDemand
      : state.baseWaitMin;

    return {
      coveragePct,
      peakFleet,
      totalVehHours,
      idleVehHours,
      idlePct,
      paidDriverHours,
      laborCost,
      weightedWait,
    };
  }

  function buildSuppliedFromShifts(shifts) {
    const supplied = new Array(19).fill(0);
    const fleetCount = new Array(19).fill(0);
    for (const sh of shifts) {
      applyShiftToSupplied(sh.start, sh.length, supplied, fleetCount);
    }
    return { supplied, fleetCount };
  }

  function runOptimizer() {
    const t0 = performance.now();
    state.required = computeRequired();
    const result = optimizeShifts(state.required, state.maxFleet);
    state.shifts = result.shifts;
    state.supplied = result.supplied;
    state.fleetCount = result.fleetCount;
    state.uncoveredHours = result.uncoveredHours;
    state.wait = computeWait(state.supplied, state.required);
    state.kpis = computeKPIs(state.shifts, state.supplied, state.required, state.wait);
    const elapsed = performance.now() - t0;
    if (elapsed > 50) console.warn(`Optimizer took ${elapsed.toFixed(1)}ms`);
    state.disruption = null;
  }

  function getActiveKpis() {
    if (state.disruption && state.disruption.recoveryApplied) {
      return state.disruption.recoveredKpis;
    }
    if (state.disruption) {
      return state.disruption.degradedKpis;
    }
    return state.kpis;
  }

  function findWorstCalloutDriver() {
    let worst = null;
    let worstLoss = -1;
    for (const sh of state.shifts) {
      const remaining = state.shifts.filter((s) => s.id !== sh.id);
      const { supplied } = buildSuppliedFromShifts(remaining);
      const sumRequired = state.required.reduce((a, b) => a + b, 0);
      const cov = sumRequired > 0
        ? (state.required.reduce((acc, r, i) => acc + Math.min(supplied[i], r), 0) / sumRequired) * 100
        : 100;
      const loss = state.kpis.coveragePct - cov;
      if (loss > worstLoss) {
        worstLoss = loss;
        worst = sh.id;
      }
    }
    return worst || (state.shifts[0] && state.shifts[0].id);
  }

  function applyCallout(driverId) {
    const removed = state.shifts.find((s) => s.id === driverId);
    if (!removed) return;
    const remaining = state.shifts.filter((s) => s.id !== driverId);
    const { supplied: degraded } = buildSuppliedFromShifts(remaining);
    const wait = computeWait(degraded, state.required);
    const kpis = computeKPIs(remaining, degraded, state.required, wait);

    state.disruption = {
      removedDriver: driverId,
      removedShift: removed,
      originalShifts: state.shifts.slice(),
      originalSupplied: state.supplied.slice(),
      originalKpis: { ...state.kpis },
      remainingShifts: remaining,
      degradedSupplied: degraded,
      degradedKpis: kpis,
      degradedWait: wait,
      recoveryApplied: null,
    };
    computeRecoveryOptions();
  }

  function computeRecoveryOptions() {
    if (!state.disruption) return;
    const d = state.disruption;
    const deficit = state.required.map((r, i) => Math.max(0, r - d.degradedSupplied[i]));

    d.extendPlan = planExtendRecovery(d.remainingShifts, deficit, d.degradedSupplied);
    d.oncallPlan = planOncallRecovery(deficit, d.degradedSupplied);
  }

  function planExtendRecovery(shifts, deficit, currentSupplied) {
    const mutableShifts = shifts.map((s) => ({ ...s }));
    const fleetCount = new Array(19).fill(0);
    for (const sh of mutableShifts) {
      for (const h of shiftHours(sh.start, sh.length)) {
        fleetCount[hourIndex(h)] += 1;
      }
    }
    const supplied = currentSupplied.slice();
    const workingDeficit = deficit.slice();
    const extensions = [];
    let otCost = 0;

    for (let ext = 0; ext < 2; ext++) {
      let bestShift = null;
      let bestScore = -1;
      let bestExt = 0;

      for (let si = 0; si < mutableShifts.length; si++) {
        const sh = mutableShifts[si];
        for (let addHours = 1; addHours <= 2; addHours++) {
          const newEnd = sh.end + addHours;
          if (newEnd > 24) continue;
          let value = 0;
          let feasible = true;
          for (let h = sh.end; h < newEnd; h++) {
            if (fleetCount[hourIndex(h)] + 1 > state.maxFleet) {
              feasible = false;
              break;
            }
            value += Math.max(0, workingDeficit[hourIndex(h)]);
          }
          if (!feasible || value <= 0) continue;
          const cost = addHours * state.driverWage * 1.5;
          const score = value / cost;
          if (score > bestScore) {
            bestScore = score;
            bestShift = si;
            bestExt = addHours;
          }
        }
      }

      if (bestShift === null || bestScore <= 0) break;

      const sh = mutableShifts[bestShift];
      for (let h = sh.end; h < sh.end + bestExt; h++) {
        const idx = hourIndex(h);
        supplied[idx] += 1;
        fleetCount[idx] += 1;
        workingDeficit[idx] = Math.max(0, workingDeficit[idx] - 1);
      }
      otCost += bestExt * state.driverWage * 1.5;
      extensions.push({ shiftId: sh.id, hours: bestExt });
      sh.end += bestExt;
      sh.length += bestExt;
      sh.paidHours += bestExt;
    }

    const totalOtHours = extensions.reduce((a, e) => a + e.hours, 0);
    const newWait = computeWait(supplied, state.required);
    const newKpis = computeKPIs(mutableShifts, supplied, state.required, newWait, totalOtHours);

    return {
      shifts: mutableShifts,
      supplied,
      kpis: newKpis,
      wait: newWait,
      cost: otCost,
      extensions,
      otHours: totalOtHours,
    };
  }

  function planOncallRecovery(deficit, currentSupplied) {
    let best = null;
    let bestVal = -1;

    for (let start = 5; start <= 20; start++) {
      if (start + 4 > 24) continue;
      let val = 0;
      for (let h = start; h < start + 4; h++) {
        val += Math.max(0, deficit[hourIndex(h)]);
      }
      if (val > bestVal) {
        bestVal = val;
        best = { start, length: 4, end: start + 4 };
      }
    }

    if (!best || bestVal <= 0) {
      return { shifts: [], supplied: currentSupplied.slice(), cost: 0, kpis: null, wait: null, shift: null };
    }

    const newShift = {
      id: 'ONCALL',
      start: best.start,
      end: best.end,
      length: 4,
      breakHour: null,
      paidHours: 4,
    };
    const newShifts = [...state.disruption.remainingShifts, newShift];
    const { supplied } = buildSuppliedFromShifts(newShifts);
    const wait = computeWait(supplied, state.required);
    const kpis = computeKPIs(newShifts, supplied, state.required, wait);
    const cost = 4 * state.driverWage;

    return { shifts: newShifts, supplied, kpis, wait, cost, shift: newShift };
  }

  function applyRecovery() {
    if (!state.disruption) return;
    const mode = document.querySelector('input[name="recovery"]:checked').value;
    const d = state.disruption;
    const plan = mode === 'extend' ? d.extendPlan : d.oncallPlan;
    if (!plan || !plan.kpis) return;

    d.recoveryApplied = mode;
    d.recoveredShifts = plan.shifts;
    d.recoveredSupplied = plan.supplied;
    d.recoveredKpis = plan.kpis;
    d.recoveredWait = plan.wait;
    d.recoveryCost = plan.cost;
    d.recoveryOtHours = plan.otHours || 0;
  }

  function resetDay() {
    state.disruption = null;
    runOptimizer();
    render();
  }

  function formatPct(v) {
    return `${v.toFixed(1)}%`;
  }

  function formatMoney(v) {
    return `$${Math.round(v).toLocaleString()}`;
  }

  function kpiDeltaHtml(before, after, higherIsBetter, fmt) {
    const improved = higherIsBetter ? after > before : after < before;
    const worse = higherIsBetter ? after < before : after > before;
    const cls = improved ? 'kpi-value--delta-better' : worse ? 'kpi-value--delta-worse' : '';
    return `<span class="kpi-value ${cls}">${fmt(before)} → ${fmt(after)}</span>`;
  }

  function renderWarning() {
    const banner = $('warning-banner');
    if (state.uncoveredHours > 0) {
      banner.hidden = false;
      banner.textContent = `Fleet cap reached: ${state.uncoveredHours} hour${state.uncoveredHours > 1 ? 's' : ''} cannot be fully covered at the current cap`;
    } else {
      banner.hidden = true;
    }
  }

  function renderKPIs() {
    const grid = $('kpi-grid');
    const k = getActiveKpis();
    const d = state.disruption;
    const showDelta = d && d.originalKpis;
    const orig = showDelta ? d.originalKpis : null;

    function kpiItem(label, valueHtml) {
      return `<div class="kpi-item"><div class="kpi-label">${label}</div>${valueHtml}</div>`;
    }

    function valOrDelta(before, after, higherBetter, fmt) {
      if (showDelta) {
        return kpiDeltaHtml(before, after, higherBetter, fmt);
      }
      return `<div class="kpi-value">${fmt(after)}</div>`;
    }

    grid.innerHTML = `
      ${kpiItem('Coverage', valOrDelta(orig?.coveragePct ?? k.coveragePct, k.coveragePct, true, formatPct))}
      ${kpiItem('Peak fleet', showDelta
        ? kpiDeltaHtml(orig.peakFleet, k.peakFleet, false, (v) => String(v))
        : `<div class="kpi-value">${k.peakFleet}</div>`)}
      ${kpiItem('Vehicle-hours', showDelta
        ? kpiDeltaHtml(orig.totalVehHours, k.totalVehHours, false, (v) => v.toFixed(1))
        : `<div class="kpi-value">${k.totalVehHours.toFixed(1)}</div>`)}
      ${kpiItem('Idle %', valOrDelta(orig?.idlePct ?? k.idlePct, k.idlePct, false, formatPct))}
      ${kpiItem('Paid driver hrs', showDelta
        ? kpiDeltaHtml(orig.paidDriverHours, k.paidDriverHours, false, (v) => v.toFixed(1))
        : `<div class="kpi-value">${k.paidDriverHours.toFixed(1)}</div>`)}
      ${kpiItem('Labor cost', valOrDelta(orig?.laborCost ?? k.laborCost, k.laborCost, false, formatMoney))}
      <div class="kpi-item" style="grid-column: span 2">
        <div class="kpi-label">Weighted avg wait</div>
        ${valOrDelta(orig?.weightedWait ?? k.weightedWait, k.weightedWait, false, (v) => `${v.toFixed(1)} min`)}
      </div>
    `;
  }

  function renderComparison() {
    const strip = $('comparison-strip-baseline');
    if (!state.baseline) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    const cur = getActiveKpis();
    const b = state.baseline.kpis;

    function row(label, before, after, higherBetter, fmt) {
      const improved = higherBetter ? after > before : after < before;
      const worse = higherBetter ? after < before : after > before;
      const cls = improved ? 'delta--better' : worse ? 'delta--worse' : '';
      return `<div class="comparison-row"><span>${label}</span><span class="mono ${cls}">${fmt(before)} → ${fmt(after)}</span></div>`;
    }

    strip.innerHTML = `
      <h3>Vs baseline</h3>
      ${row('Coverage', b.coveragePct, cur.coveragePct, true, formatPct)}
      ${row('Labor cost', b.laborCost, cur.laborCost, false, formatMoney)}
      ${row('Avg wait', b.weightedWait, cur.weightedWait, false, (v) => `${v.toFixed(1)} min`)}
      ${row('Idle %', b.idlePct, cur.idlePct, false, formatPct)}
    `;
  }

  function renderRecoveryOptions() {
    const opts = $('recovery-options');
    if (!state.disruption) {
      opts.hidden = true;
      return;
    }
    opts.hidden = false;
    const d = state.disruption;
    const ext = d.extendPlan;
    const onc = d.oncallPlan;

    $('recovery-extend-label').textContent = ext && ext.cost > 0
      ? `Extend shifts — up to 2 shifts by 1–2 hrs (${formatMoney(ext.cost)} OT)`
      : 'Extend shifts — no viable extensions';
    $('recovery-oncall-label').textContent = onc && onc.cost > 0
      ? `Call in on-call driver — 4-hr shift (${formatMoney(onc.cost)})`
      : 'Call in on-call driver — no viable slot';
  }

  function renderCoverageChart() {
    const container = $('coverage-chart');
    const W = 700;
    const H = 220;
    const padL = 40;
    const padR = 50;
    const padT = 16;
    const padB = 32;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const barW = chartW / 19 - 2;

    const required = state.required;
    const supplied = state.disruption
      ? (state.disruption.recoveryApplied
        ? state.disruption.recoveredSupplied
        : state.disruption.degradedSupplied)
      : state.supplied;
    const origSupplied = state.disruption ? state.disruption.originalSupplied : null;
    const wait = state.disruption
      ? (state.disruption.recoveryApplied ? state.disruption.recoveredWait : state.disruption.degradedWait)
      : state.wait;

    const maxY = Math.max(...required, ...(origSupplied || supplied), 1);
    const showWait = wait.some((w, i) => w > state.baseWaitMin && state.demand[i] > 0);
    const maxWait = showWait ? Math.max(...wait, state.baseWaitMin) : state.baseWaitMin;

    const yScale = (v) => padT + chartH - (v / maxY) * chartH;
    const yWaitScale = (w) => padT + chartH - ((w / maxWait) * chartH);
    const xPos = (i) => padL + i * (chartW / 19) + 1;

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Coverage chart with required fleet line and supplied vehicle bars">`;
    svg += '<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#b4471f" stroke-width="1" opacity="0.4"/></pattern></defs>';

    for (let i = 0; i <= 4; i++) {
      const y = padT + (chartH / 4) * i;
      svg += `<line class="gantt-grid" x1="${padL}" y1="${y}" x2="${padL + chartW}" y2="${y}"/>`;
    }

    for (let i = 0; i < 19; i++) {
      const x = xPos(i);
      const sup = supplied[i];
      const barH = (sup / maxY) * chartH;
      const y = padT + chartH - barH;

      if (origSupplied) {
        const origH = (origSupplied[i] / maxY) * chartH;
        svg += `<rect class="chart-bar chart-bar--supply-muted" x="${x}" y="${padT + chartH - origH}" width="${barW}" height="${origH}"/>`;
      }

      svg += `<rect class="chart-bar chart-bar--supply" x="${x}" y="${y}" width="${barW}" height="${barH}"/>`;

      if (sup < required[i]) {
        const defTop = y;
        const defBot = yScale(required[i]);
        const defH = defBot - defTop;
        if (defH > 0) {
          svg += `<rect x="${x}" y="${defTop}" width="${barW}" height="${defH}" fill="url(#hatch)"/>`;
        }
      }
    }

    let linePath = '';
    for (let i = 0; i < 19; i++) {
      const x = xPos(i) + barW / 2;
      const y = yScale(required[i]);
      linePath += i === 0 ? `M${x},${y}` : `L${x},${y}`;
      if (i < 18) {
        const nx = xPos(i + 1) + barW / 2;
        linePath += `L${nx},${y}`;
      }
    }
    svg += `<path class="chart-line" d="${linePath}"/>`;

    if (showWait) {
      let waitPath = '';
      for (let i = 0; i < 19; i++) {
        if (state.demand[i] === 0) continue;
        const x = xPos(i) + barW / 2;
        const wy = yWaitScale(wait[i]);
        waitPath += waitPath ? `L${x},${wy}` : `M${x},${wy}`;
      }
      svg += `<path class="chart-line chart-line--wait" d="${waitPath}"/>`;
      svg += `<text class="chart-axis" x="${W - padR + 4}" y="${padT + 8}" font-size="9" fill="#6b645a">wait</text>`;
    }

    for (let i = 0; i < 19; i += 2) {
      const x = xPos(i) + barW / 2;
      svg += `<text class="chart-axis" x="${x}" y="${H - 8}" text-anchor="middle">${HOURS[i]}</text>`;
    }

    for (let i = 0; i <= 4; i++) {
      const val = Math.round(maxY * (1 - i / 4));
      const y = padT + (chartH / 4) * i;
      svg += `<text class="chart-axis" x="${padL - 6}" y="${y + 3}" text-anchor="end">${val}</text>`;
    }

    svg += '</svg>';
    container.innerHTML = svg;
  }

  function renderDemandChart() {
    const container = $('demand-chart');
    const W = 700;
    const H = 140;
    const padL = 40;
    const padR = 16;
    const padT = 12;
    const padB = 28;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const barW = chartW / 19 - 2;
    const maxD = Math.max(...state.demand, 1);

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Demand profile chart, drag bars to adjust rides per hour">`;

    for (let i = 0; i < 19; i++) {
      const x = padL + i * (chartW / 19) + 1;
      const barH = (state.demand[i] / maxD) * chartH;
      const y = padT + chartH - barH;
      svg += `<rect class="chart-bar chart-bar--demand" data-hour-idx="${i}" x="${x}" y="${y}" width="${barW}" height="${barH}" tabindex="0" role="slider" aria-label="Demand hour ${HOURS[i]}, ${state.demand[i]} rides" aria-valuemin="0" aria-valuemax="200" aria-valuenow="${state.demand[i]}"/>`;
    }

    for (let i = 0; i < 19; i += 2) {
      const x = padL + i * (chartW / 19) + barW / 2 + 1;
      svg += `<text class="chart-axis" x="${x}" y="${H - 6}" text-anchor="middle">${HOURS[i]}</text>`;
    }

    svg += '</svg>';
    container.innerHTML = svg;

    container.querySelectorAll('.chart-bar--demand').forEach((bar) => {
      bar.addEventListener('mousedown', onDemandDragStart);
      bar.addEventListener('touchstart', onDemandDragStart, { passive: false });
      bar.addEventListener('keydown', onDemandKeyAdjust);
    });
  }

  function onDemandKeyAdjust(e) {
    const bar = e.target;
    const idx = +bar.dataset.hourIdx;
    let delta = 0;
    if (e.key === 'ArrowUp') delta = 2;
    else if (e.key === 'ArrowDown') delta = -2;
    else return;
    e.preventDefault();
    state.demand[idx] = Math.max(0, state.demand[idx] + delta);
    state.preset = 'manual';
    updatePresetButtons();
    renderDemandChart();
    renderDemandGrid();
    scheduleUpdate();
  }

  function renderDemandGrid() {
    const grid = $('demand-grid');
    grid.innerHTML = HOURS.map((h, i) => `
      <div class="demand-grid__cell">
        <span class="demand-grid__hour">${h}</span>
        <input type="number" min="0" max="200" value="${state.demand[i]}" data-hour-idx="${i}" aria-label="Demand hour ${h}">
      </div>
    `).join('');

    grid.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = +inp.dataset.hourIdx;
        state.demand[idx] = Math.max(0, +inp.value || 0);
        state.preset = 'manual';
        updatePresetButtons();
        scheduleUpdate();
      });
    });
  }

  function getDisplayShifts() {
    if (state.disruption) {
      return state.disruption.recoveryApplied
        ? state.disruption.recoveredShifts
        : state.disruption.remainingShifts;
    }
    return state.shifts;
  }

  function renderGantt() {
    const container = $('gantt-chart');
    const shifts = getDisplayShifts();

    $('gantt-summary').textContent = shifts.length
      ? `${shifts.length} driver${shifts.length !== 1 ? 's' : ''} on the timeline`
      : 'No shifts scheduled';

    if (!shifts.length) {
      container.innerHTML = '<p style="color:var(--muted);font-size:0.875rem">No shifts generated.</p>';
      return;
    }

    const rowH = 28;
    const padL = 50;
    const padT = 8;
    const padB = 24;
    const hourW = 32;
    const totalHours = 19;
    const W = padL + totalHours * hourW + 16;
    const H = padT + shifts.length * rowH + padB;

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Gantt chart with ${shifts.length} driver rows from hour 5 to 24">`;

    for (let i = 0; i < totalHours; i++) {
      const x = padL + i * hourW;
      svg += `<line class="gantt-grid" x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}"/>`;
      if (i % 2 === 0) {
        svg += `<text class="gantt-label" x="${x + hourW / 2}" y="${H - 6}" text-anchor="middle">${HOURS[i]}</text>`;
      }
    }

    shifts.forEach((sh, ri) => {
      const y = padT + ri * rowH + 4;
      svg += `<text class="gantt-label" x="${padL - 6}" y="${y + 14}" text-anchor="end">${sh.id}</text>`;

      for (let h = sh.start; h < sh.end; h++) {
        const hi = hourIndex(h);
        const x = padL + hi * hourW + 1;
        const isBreak = sh.breakHour === h;
        svg += `<rect class="gantt-bar${isBreak ? ' gantt-bar--break' : ''}" x="${x}" y="${y}" width="${hourW - 2}" height="${rowH - 8}" rx="2"/>`;
      }
    });

    svg += '</svg>';
    container.innerHTML = svg;
  }

  function renderShiftTable() {
    const tbody = $('shift-tbody');
    const shifts = getDisplayShifts();

    $('shift-summary').textContent = `${shifts.length} driver${shifts.length !== 1 ? 's' : ''} scheduled`;

    tbody.innerHTML = shifts.map((sh) => `
      <tr>
        <td>${sh.id}</td>
        <td>${hourLabel(sh.start)}</td>
        <td>${hourLabel(sh.end)}</td>
        <td>${sh.length}h</td>
        <td>${sh.breakHour !== null ? hourLabel(sh.breakHour) : '—'}</td>
        <td>${sh.paidHours}</td>
      </tr>
    `).join('');
  }

  function renderCalloutDropdown() {
    const sel = $('callout-driver');
    const worst = findWorstCalloutDriver();
    sel.innerHTML = state.shifts.map((sh) =>
      `<option value="${sh.id}"${sh.id === worst ? ' selected' : ''}>${sh.id} (${hourLabel(sh.start)}–${hourLabel(sh.end)})</option>`
    ).join('');
  }

  function renderBaselineStatus() {
    const status = $('baseline-status');
    const clearBtn = $('btn-clear-baseline');
    if (state.baseline) {
      status.textContent = 'Baseline pinned. KPI deltas shown below.';
      clearBtn.hidden = false;
    } else {
      status.textContent = 'No baseline pinned.';
      clearBtn.hidden = true;
    }
  }

  function updatePresetButtons() {
    document.querySelectorAll('.btn-preset').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.preset);
    });
  }

  function render() {
    renderWarning();
    renderKPIs();
    renderComparison();
    renderRecoveryOptions();
    renderCoverageChart();
    renderDemandChart();
    renderDemandGrid();
    renderGantt();
    renderShiftTable();
    renderCalloutDropdown();
    renderBaselineStatus();
    updatePresetButtons();
  }

  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runOptimizer();
      render();
    }, DEBOUNCE_MS);
  }

  function onDemandDragStart(e) {
    e.preventDefault();
    const bar = e.target;
    const idx = +bar.dataset.hourIdx;
    const svg = bar.closest('svg');
    const rect = svg.getBoundingClientRect();
    const chartH = 140 - 12 - 28;

    dragState = { idx, svg, rect, chartH };
    document.addEventListener('mousemove', onDemandDrag);
    document.addEventListener('mouseup', onDemandDragEnd);
    document.addEventListener('touchmove', onDemandDrag, { passive: false });
    document.addEventListener('touchend', onDemandDragEnd);
  }

  function onDemandDrag(e) {
    if (!dragState) return;
    e.preventDefault();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const padT = 12;
    const relY = clientY - dragState.rect.top - padT;
    const maxD = Math.max(...state.demand, 1);
    const ratio = 1 - Math.max(0, Math.min(1, relY / dragState.chartH));
    const newVal = Math.round(ratio * maxD * 1.2);
    state.demand[dragState.idx] = Math.max(0, newVal);
    state.preset = 'manual';
    updatePresetButtons();
    renderDemandChart();
    renderDemandGrid();
    scheduleUpdate();
  }

  function onDemandDragEnd() {
    dragState = null;
    document.removeEventListener('mousemove', onDemandDrag);
    document.removeEventListener('mouseup', onDemandDragEnd);
    document.removeEventListener('touchmove', onDemandDrag);
    document.removeEventListener('touchend', onDemandDragEnd);
  }

  function bindEvents() {
    document.querySelectorAll('.btn-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        state.preset = preset;
        if (preset !== 'manual' && PRESETS[preset]) {
          state.demand = PRESETS[preset].slice();
        }
        updatePresetButtons();
        scheduleUpdate();
      });
    });

    $('rides-per-veh').addEventListener('input', (e) => {
      state.ridesPerVehHour = +e.target.value;
      $('rides-per-veh-val').textContent = state.ridesPerVehHour.toFixed(1);
      scheduleUpdate();
    });

    $('buffer-pct').addEventListener('input', (e) => {
      state.bufferPct = +e.target.value;
      $('buffer-pct-val').textContent = `${state.bufferPct}%`;
      scheduleUpdate();
    });

    $('base-wait').addEventListener('input', (e) => {
      state.baseWaitMin = +e.target.value;
      $('base-wait-val').textContent = state.baseWaitMin;
      scheduleUpdate();
    });

    $('driver-wage').addEventListener('change', (e) => {
      state.driverWage = Math.max(15, Math.min(40, +e.target.value || 22));
      e.target.value = state.driverWage;
      if (state.disruption) computeRecoveryOptions();
      scheduleUpdate();
    });

    $('max-fleet').addEventListener('change', (e) => {
      state.maxFleet = Math.max(1, +e.target.value || 40);
      e.target.value = state.maxFleet;
      scheduleUpdate();
    });

    $('btn-remove-driver').addEventListener('click', () => {
      const id = $('callout-driver').value;
      applyCallout(id);
      render();
    });

    $('btn-apply-recovery').addEventListener('click', () => {
      applyRecovery();
      render();
    });

    $('btn-reset-day').addEventListener('click', resetDay);

    $('btn-pin-baseline').addEventListener('click', () => {
      state.baseline = {
        kpis: { ...state.kpis },
        settings: {
          bufferPct: state.bufferPct,
          ridesPerVehHour: state.ridesPerVehHour,
          demand: state.demand.slice(),
        },
      };
      render();
    });

    $('btn-clear-baseline').addEventListener('click', () => {
      state.baseline = null;
      render();
    });
  }

  function init() {
    bindEvents();
    runOptimizer();
    render();
  }

  init();
})();
