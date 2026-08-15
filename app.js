(() => {
  const appEl = document.getElementById('app');
  const timerBox = document.getElementById('timerBox');
  const timerValue = document.getElementById('timerValue');
  const quitBtn = document.getElementById('quitBtn');

  const ALL_Q = QUESTIONS; // from questions.js
  const DOMAIN_LIST = DOMAINS; // from questions.js

  // AgentCore Runtime上のStrands Agent(aipquizcoach)を叩くAPI Gatewayプロキシ
  const AGENT_API = "https://k274l7ontb.execute-api.us-east-1.amazonaws.com/";
  const HISTORY_KEY = "aip_history_v1";
  const HISTORY_MAX = 300;

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveHistoryEntry(entry) {
    const h = loadHistory();
    h.push(entry);
    while (h.length > HISTORY_MAX) h.shift();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  }

  function historyEntryFor(q, correct) {
    return {
      id: q.id,
      domain: q.domain,
      domainName: domainName(q.domain),
      correct,
      question: q.question.slice(0, 200),
      explanation: q.explanation.slice(0, 300),
      ts: Date.now(),
    };
  }

  async function callAgent(body) {
    const res = await fetch(AGENT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`agent call failed: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  const state = {
    mode: null,          // 'random200' | 'category100' | 'mock85' | 'flash150'
    showFeedback: true,  // false for mock exam
    questions: [],
    answers: {},          // qId -> array of selected option ids
    submitted: {},         // qId -> bool
    current: 0,
    timerId: null,
    secondsLeft: 0,
    flashFlipped: false,
  };

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function domainName(id) {
    const d = DOMAIN_LIST.find(x => x.id === id);
    return d ? d.nameJa : '';
  }

  function byDomain(id) {
    return ALL_Q.filter(q => q.domain === id);
  }

  // ---------- Home ----------
  function renderHome() {
    quitBtn.classList.add('hidden');
    timerBox.classList.add('hidden');
    stopTimer();
    const tpl = document.getElementById('tpl-home');
    appEl.innerHTML = '';
    appEl.appendChild(tpl.content.cloneNode(true));

    document.getElementById('stockCount').textContent = ALL_Q.length.toLocaleString();

    const chipsEl = document.getElementById('domainChips');
    DOMAIN_LIST.forEach(d => {
      const chip = document.createElement('span');
      chip.className = 'domain-chip';
      chip.textContent = `D${d.id}: ${d.nameJa} (${d.weight}% / ${byDomain(d.id).length}問)`;
      chipsEl.appendChild(chip);
    });

    const catSelect = document.getElementById('categorySelect');
    DOMAIN_LIST.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `ドメイン${d.id}: ${d.nameJa}`;
      catSelect.appendChild(opt);
    });

    appEl.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === 'category100') {
          startCategory100(parseInt(catSelect.value, 10));
        } else if (mode === 'random200') {
          startRandom200();
        } else if (mode === 'mock85') {
          startMock85();
        } else if (mode === 'flash150') {
          startFlash150();
        }
      });
    });

    wireAiPanel();
  }

  function wireAiPanel() {
    const weakBtn = document.getElementById('weakFocusBtn');
    const weakStatus = document.getElementById('weakFocusStatus');
    weakBtn.addEventListener('click', async () => {
      weakBtn.disabled = true;
      weakStatus.textContent = 'AIが問題を選定中…(数十秒かかる場合があります)';
      try {
        const pool = ALL_Q.map(q => ({ id: q.id, domain: q.domain }));
        const history = loadHistory().map(h => ({ id: h.id, domain: h.domain, correct: h.correct }));
        const res = await callAgent({ action: 'pick', mode: 'weak_focus', count: 30, pool, history });
        const byId = new Map(ALL_Q.map(q => [q.id, q]));
        const ordered = (res.selected_ids || []).map(id => byId.get(id)).filter(Boolean);
        if (!ordered.length) throw new Error('empty selection');
        beginQuiz('weakfocus', ordered, true, 'AIおすすめ: 苦手問題を復習');
      } catch (e) {
        weakStatus.textContent = 'AIの呼び出しに失敗しました。しばらくしてから再度お試しください。';
        weakBtn.disabled = false;
      }
    });

    const analyzeBtn = document.getElementById('analyzeBtn');
    const analyzeResult = document.getElementById('analyzeResult');
    analyzeBtn.addEventListener('click', async () => {
      const history = loadHistory();
      analyzeResult.classList.remove('hidden');
      if (!history.length) {
        analyzeResult.textContent = 'まだ演習履歴がありません。まずは問題を解いてみてください。';
        return;
      }
      analyzeBtn.disabled = true;
      analyzeResult.textContent = 'AIが分析中…(数十秒かかる場合があります)';
      try {
        const payloadHistory = history.map(h => ({
          id: h.id,
          domain: h.domain,
          domain_name: h.domainName,
          correct: h.correct,
          question: h.correct ? undefined : h.question,
          explanation: h.correct ? undefined : h.explanation,
        }));
        const res = await callAgent({ action: 'analyze', history: payloadHistory });
        analyzeResult.textContent = res.analysis || '分析結果を取得できませんでした。';
      } catch (e) {
        analyzeResult.textContent = 'AIの呼び出しに失敗しました。しばらくしてから再度お試しください。';
      } finally {
        analyzeBtn.disabled = false;
      }
    });
  }

  // ---------- Mode starters ----------
  function startRandom200() {
    const pool = shuffle(ALL_Q).slice(0, Math.min(200, ALL_Q.length));
    beginQuiz('random200', pool, true, 'ランダム出題');
  }

  function startCategory100(domainId) {
    const pool = shuffle(byDomain(domainId)).slice(0, 100);
    beginQuiz('category100', pool, true, `カテゴリー別: ${domainName(domainId)}`);
  }

  function startMock85() {
    const total = 85;
    // Largest remainder method based on domain weights
    const raw = DOMAIN_LIST.map(d => ({ id: d.id, exact: (d.weight / 100) * total }));
    raw.forEach(r => r.base = Math.floor(r.exact));
    let assigned = raw.reduce((s, r) => s + r.base, 0);
    let remainder = total - assigned;
    const byFrac = raw.slice().sort((a, b) => (b.exact - b.base) - (a.exact - a.base));
    for (let i = 0; i < remainder; i++) byFrac[i % byFrac.length].base += 1;

    let pool = [];
    raw.forEach(r => {
      const available = byDomain(r.id);
      const take = Math.min(r.base, available.length);
      pool = pool.concat(shuffle(available).slice(0, take));
    });
    // Top up if any domain came up short (bank not yet at 1000)
    if (pool.length < total) {
      const usedIds = new Set(pool.map(q => q.id));
      const leftover = shuffle(ALL_Q.filter(q => !usedIds.has(q.id)));
      pool = pool.concat(leftover.slice(0, total - pool.length));
    }
    pool = shuffle(pool);
    beginQuiz('mock85', pool, false, '模擬試験');
  }

  function startFlash150() {
    const pool = shuffle(ALL_Q).slice(0, Math.min(150, ALL_Q.length));
    beginFlash(pool);
  }

  // ---------- Quiz engine ----------
  function beginQuiz(mode, questions, showFeedback, label) {
    state.mode = mode;
    state.questions = questions;
    state.showFeedback = showFeedback;
    state.answers = {};
    state.submitted = {};
    state.current = 0;

    quitBtn.classList.remove('hidden');
    quitBtn.onclick = () => {
      if (confirm('学習を中断してホームに戻りますか?進捗は失われます。')) renderHome();
    };

    const tpl = document.getElementById('tpl-quiz');
    appEl.innerHTML = '';
    appEl.appendChild(tpl.content.cloneNode(true));
    document.getElementById('quizModeLabel').textContent = label;

    const navEl = document.querySelector('.quiz-nav');
    const navToggleBtn = document.getElementById('navToggleBtn');
    navToggleBtn.addEventListener('click', () => {
      const collapsed = navEl.classList.toggle('is-collapsed');
      navToggleBtn.textContent = collapsed ? '▼' : '▲';
      navToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    });

    buildNavGrid();
    renderQuestion();

    if (mode === 'mock85') {
      timerBox.classList.remove('hidden');
      state.secondsLeft = 180 * 60;
      startTimer();
    } else {
      timerBox.classList.add('hidden');
    }
  }

  function buildNavGrid() {
    const grid = document.getElementById('qNavGrid');
    grid.innerHTML = '';
    state.questions.forEach((q, i) => {
      const b = document.createElement('button');
      b.className = 'qnav-btn';
      b.textContent = i + 1;
      b.dataset.index = i;
      b.addEventListener('click', () => {
        state.current = i;
        renderQuestion();
      });
      grid.appendChild(b);
    });
  }

  function updateNavGrid() {
    const grid = document.getElementById('qNavGrid');
    [...grid.children].forEach((b, i) => {
      b.classList.remove('is-current', 'is-correct', 'is-incorrect');
      const q = state.questions[i];
      if (i === state.current) b.classList.add('is-current');
      if (state.submitted[q.id]) {
        const correct = isAnswerCorrect(q);
        b.classList.add(correct ? 'is-correct' : 'is-incorrect');
      }
    });
    const answeredCount = Object.keys(state.submitted).length;
    document.getElementById('quizProgressLabel').textContent =
      `${state.current + 1} / ${state.questions.length} (回答済み ${answeredCount})`;
    document.getElementById('progressFill').style.width =
      `${((state.current + 1) / state.questions.length) * 100}%`;
  }

  function isAnswerCorrect(q) {
    const sel = (state.answers[q.id] || []).slice().sort();
    const correct = q.correct.slice().sort();
    return sel.length === correct.length && sel.every((v, i) => v === correct[i]);
  }

  function renderQuestion() {
    const q = state.questions[state.current];
    const isMulti = q.type === 'multi';

    document.getElementById('qDomainBadge').textContent = `D${q.domain}: ${domainName(q.domain)}`;
    document.getElementById('qTypeBadge').textContent = isMulti
      ? `複数選択(${q.correct.length}つ選択)` : '単一選択';
    document.getElementById('qText').textContent = q.question;

    const optsEl = document.getElementById('qOptions');
    optsEl.innerHTML = '';
    const alreadySubmitted = !!state.submitted[q.id];
    const selected = state.answers[q.id] || [];

    q.options.forEach(opt => {
      const row = document.createElement('label');
      row.className = 'qoption';
      const input = document.createElement('input');
      input.type = isMulti ? 'checkbox' : 'radio';
      input.name = 'qopt';
      input.value = opt.id;
      input.checked = selected.includes(opt.id);
      input.disabled = alreadySubmitted && state.showFeedback;

      input.addEventListener('change', () => {
        let cur = state.answers[q.id] || [];
        if (isMulti) {
          if (input.checked) cur = [...cur, opt.id];
          else cur = cur.filter(v => v !== opt.id);
        } else {
          cur = [opt.id];
        }
        state.answers[q.id] = cur;
        syncOptionStyles();
      });

      const text = document.createElement('span');
      text.textContent = `${opt.id}. ${opt.text}`;

      row.appendChild(input);
      row.appendChild(text);
      optsEl.appendChild(row);
    });

    syncOptionStyles();

    const feedback = document.getElementById('qFeedback');
    const submitBtn = document.getElementById('submitBtn');
    const nextBtn = document.getElementById('nextBtn');
    const finishBtn = document.getElementById('finishBtn');
    const isLast = state.current === state.questions.length - 1;

    if (state.showFeedback && alreadySubmitted) {
      showFeedback(q);
      submitBtn.classList.add('hidden');
    } else {
      feedback.classList.add('hidden');
      submitBtn.classList.remove('hidden');
      submitBtn.disabled = false;
    }

    nextBtn.classList.toggle('hidden', isLast);
    finishBtn.classList.toggle('hidden', !isLast);
    document.getElementById('prevBtn').disabled = state.current === 0;

    // In no-feedback (mock) mode, submit just records answer & is always visible except styling
    if (!state.showFeedback) {
      submitBtn.classList.toggle('hidden', true);
    }

    updateNavGrid();
  }

  function syncOptionStyles() {
    const q = state.questions[state.current];
    const selected = state.answers[q.id] || [];
    const submitted = !!state.submitted[q.id];
    [...document.getElementById('qOptions').children].forEach(row => {
      const input = row.querySelector('input');
      row.classList.toggle('is-selected', input.checked);
      row.classList.remove('is-correct', 'is-incorrect');
      if (state.showFeedback && submitted) {
        row.classList.add('is-disabled');
        const isCorrectOpt = q.correct.includes(input.value);
        if (isCorrectOpt) row.classList.add('is-correct');
        else if (input.checked) row.classList.add('is-incorrect');
      }
    });
  }

  function showFeedback(q) {
    const feedback = document.getElementById('qFeedback');
    const head = document.getElementById('qFeedbackHead');
    const correct = isAnswerCorrect(q);
    head.textContent = correct ? '✓ 正解' : `✗ 不正解 (正解: ${q.correct.join(', ')})`;
    head.className = 'qfeedback-head ' + (correct ? 'correct' : 'incorrect');
    document.getElementById('qExplanation').textContent = q.explanation;
    feedback.classList.remove('hidden');
  }

  document.getElementById('app').addEventListener('click', (e) => {
    if (e.target.id === 'submitBtn') {
      const q = state.questions[state.current];
      if (!(state.answers[q.id] || []).length) return;
      state.submitted[q.id] = true;
      saveHistoryEntry(historyEntryFor(q, isAnswerCorrect(q)));
      renderQuestion();
    } else if (e.target.id === 'nextBtn') {
      if (!state.showFeedback) {
        // mock mode: mark visited even without explicit submit
        const q = state.questions[state.current];
        if ((state.answers[q.id] || []).length) state.submitted[q.id] = true;
      }
      state.current = Math.min(state.current + 1, state.questions.length - 1);
      renderQuestion();
    } else if (e.target.id === 'prevBtn') {
      state.current = Math.max(state.current - 1, 0);
      renderQuestion();
    } else if (e.target.id === 'finishBtn') {
      finishQuiz();
    } else if (e.target.id === 'homeBtn') {
      renderHome();
    } else if (e.target.id === 'reviewBtn') {
      document.getElementById('reviewList').classList.toggle('hidden');
    }
  });

  // ---------- Timer (mock exam) ----------
  function startTimer() {
    updateTimerDisplay();
    state.timerId = setInterval(() => {
      state.secondsLeft--;
      updateTimerDisplay();
      if (state.secondsLeft <= 0) {
        stopTimer();
        alert('制限時間になりました。ここまでの回答で採点します。');
        finishQuiz();
      }
    }, 1000);
  }

  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
  }

  function updateTimerDisplay() {
    const m = Math.floor(state.secondsLeft / 60);
    const s = state.secondsLeft % 60;
    timerValue.textContent = `${m}:${String(s).padStart(2, '0')}`;
    timerBox.classList.toggle('time-low', state.secondsLeft <= 300);
  }

  // ---------- Finish / Results ----------
  function finishQuiz() {
    stopTimer();
    // mark current answered question as submitted in mock mode too
    const q = state.questions[state.current];
    if ((state.answers[q.id] || []).length) state.submitted[q.id] = true;

    if (!state.showFeedback) {
      // mock exam: 1問ごとの解説はないため、終了時にまとめて履歴を記録する
      state.questions.forEach(qq => {
        if (state.submitted[qq.id]) {
          saveHistoryEntry(historyEntryFor(qq, isAnswerCorrect(qq)));
        }
      });
    }

    quitBtn.classList.add('hidden');
    timerBox.classList.add('hidden');

    const total = state.questions.length;
    let correctCount = 0;
    const domainStats = {};
    DOMAIN_LIST.forEach(d => { domainStats[d.id] = { correct: 0, total: 0 }; });

    state.questions.forEach(q => {
      const answered = !!state.submitted[q.id];
      const correct = answered && isAnswerCorrect(q);
      if (correct) correctCount++;
      domainStats[q.domain].total++;
      if (correct) domainStats[q.domain].correct++;
    });

    const tpl = document.getElementById('tpl-result');
    appEl.innerHTML = '';
    appEl.appendChild(tpl.content.cloneNode(true));

    const pct = total ? Math.round((correctCount / total) * 100) : 0;
    document.getElementById('resultTitle').textContent =
      state.mode === 'mock85' ? '模擬試験 結果' : '演習結果';
    document.getElementById('resultScore').textContent = `${correctCount} / ${total} 正解 (${pct}%)`;

    const barsEl = document.getElementById('resultBars');
    DOMAIN_LIST.forEach(d => {
      const st = domainStats[d.id];
      if (!st.total) return;
      const row = document.createElement('div');
      row.className = 'result-bar-row';
      const p = Math.round((st.correct / st.total) * 100);
      row.innerHTML = `
        <span class="label">D${d.id}: ${d.nameJa}</span>
        <div class="result-bar-track"><div class="result-bar-fill" style="width:${p}%"></div></div>
        <span>${st.correct}/${st.total}</span>`;
      barsEl.appendChild(row);
    });

    const reviewEl = document.getElementById('reviewList');
    state.questions.forEach((q, i) => {
      const answered = !!state.submitted[q.id];
      const correct = answered && isAnswerCorrect(q);
      const item = document.createElement('div');
      item.className = 'review-item ' + (correct ? '' : 'wrong');
      const selText = (state.answers[q.id] || []).join(', ') || 'なし';
      item.innerHTML = `
        <div class="qtext">${i + 1}. ${escapeHtml(q.question)}</div>
        <p><strong>あなたの回答:</strong> ${escapeHtml(selText)} / <strong>正解:</strong> ${escapeHtml(q.correct.join(', '))}</p>
        <p class="qexplanation">${escapeHtml(q.explanation)}</p>`;
      reviewEl.appendChild(item);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ---------- Flashcards ----------
  function beginFlash(pool) {
    state.mode = 'flash150';
    state.questions = pool;
    state.current = 0;
    state.flashFlipped = false;

    quitBtn.classList.remove('hidden');
    quitBtn.onclick = () => renderHome();
    timerBox.classList.add('hidden');

    const tpl = document.getElementById('tpl-flash');
    appEl.innerHTML = '';
    appEl.appendChild(tpl.content.cloneNode(true));
    renderFlash();

    document.getElementById('flashCard').addEventListener('click', toggleFlash);
    document.getElementById('flashFlip').addEventListener('click', toggleFlash);
    document.getElementById('flashNext').addEventListener('click', () => {
      state.current = (state.current + 1) % state.questions.length;
      state.flashFlipped = false;
      renderFlash();
    });
    document.getElementById('flashPrev').addEventListener('click', () => {
      state.current = (state.current - 1 + state.questions.length) % state.questions.length;
      state.flashFlipped = false;
      renderFlash();
    });
  }

  function toggleFlash() {
    state.flashFlipped = !state.flashFlipped;
    document.getElementById('flashCard').classList.toggle('is-flipped', state.flashFlipped);
  }

  function renderFlash() {
    const q = state.questions[state.current];
    document.getElementById('flashProgressLabel').textContent =
      `${state.current + 1} / ${state.questions.length}`;
    document.getElementById('flashProgressFill').style.width =
      `${((state.current + 1) / state.questions.length) * 100}%`;
    document.getElementById('flashDomainBadge').textContent = `D${q.domain}: ${domainName(q.domain)}`;
    document.getElementById('flashQuestion').textContent = q.question;
    const correctOpts = q.options.filter(o => q.correct.includes(o.id)).map(o => `${o.id}. ${o.text}`);
    document.getElementById('flashAnswer').textContent = correctOpts.join(' / ');
    document.getElementById('flashExplain').textContent = q.explanation;
    document.getElementById('flashCard').classList.remove('is-flipped');
  }

  renderHome();
})();
