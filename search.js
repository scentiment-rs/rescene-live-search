// 검색 로직. 웹페이지(index.html)와 품질 점검 스크립트(scripts/eval_search.js)가 같이 쓴다.
const RSearch = (() => {
  const norm = s => s.toLowerCase().replace(/[\s.,!?~…·'"“”‘’()\[\]-]/g, "");

  // ── 검색어 해석 ──
  // 팬들은 "원이가 도마뱀을 머리위에 올려둔 영상"처럼 문장으로 검색한다.
  // 조사·어미와 "영상/장면" 같은 말을 떼어 핵심 단어만 남기고, 멤버 별명은 같은 멤버의 다른 이름도 인정한다.
  const STOP = new Set(["영상", "장면", "라이브", "부분", "거", "것", "때", "나오는", "나온", "있는", "있던",
    "어디", "몇분", "찾아", "찾아줘", "그", "좀", "막", "같이", "하는", "했던", "하던", "한", "된",
    "위에", "옆에", "앞에", "뒤에", "안에", "밑에"]);
  const PARTICLE = /(에서|이랑|한테|에게|까지|부터|처럼|으로|랑|와|과|가|을|를|은|는|의|에|도|로|이)$/;
  const ENDING = /(하는|했던|하던|해서|했다|하고|하며|던|둔|는|며|한)$/;

  let synMap = new Map();
  let memberGroups = new Map(); // 멤버 이름 → 그 멤버의 모든 별명(정규화)
  let nicknames = new Set();     // 멤버 이름·별명 전부 (정규화)

  // data.json을 받은 뒤 한 번 호출: 동의어 사전과 검색용 정규화 텍스트를 만든다
  function prepare(DB) {
    synMap = new Map();
    memberGroups = new Map();
    nicknames = new Set();
    const members = new Set(DB.members || []);
    for (const group of DB.synonyms) {
      const g = group.map(norm);
      for (const n of g) synMap.set(n, g);
      memberGroups.set(group[0], g);
      if (members.has(group[0])) g.forEach(n => nicknames.add(n));
    }
    // 대화는 Whisper 문장(s[1])과 같은 시간대 유튜브 자막(s[2])을 합쳐서 찾는다
    for (const v of DB.videos) {
      // 출연 멤버의 이름·별명 전부. 검색어에 이 이름이 있으면 대화에 안 나와도 맞은 것으로 친다.
      v.cast = new Set((v.members || []).flatMap(m => memberGroups.get(m) || []));
      v.n = v.segs.map(s => norm(s[1] + (s[2] || "")));
      for (const sc of v.scenes) sc.n = norm(sc[3].join(" "));
    }
  }

  function stem(w) {
    if (synMap.has(w)) return w;
    for (const re of [PARTICLE, ENDING]) {
      const cut = w.replace(re, "");
      if (cut.length >= 2 && cut !== w) {
        if (synMap.has(cut)) return cut;
        w = cut;
      }
    }
    return w;
  }

  // 검색어마다 [입력한 단어, ...같은 뜻의 별명] 배열.
  // 멤버 이름·별명이면 alts.exact 에 입력한 단어를 둔다: "과영이"로 검색하면 "과영이"라고 부른 장면을 원하는 것이므로
  // 다른 별명("제나", "까엉이")으로만 맞은 결과보다 앞에 둔다. 일반 용어("도마뱀"↔"마뱀이")는 똑같이 취급한다.
  function parseQuery(q) {
    const words = q.trim().split(/\s+/).map(norm).filter(Boolean);
    const kept = words.filter(w => !STOP.has(w)).map(stem).filter(w => !STOP.has(w));
    return [...new Set(kept.length ? kept : words)].map(t => {
      const alts = [t, ...(synMap.get(t) || []).filter(x => x !== t)];
      alts.exact = nicknames.has(t) ? t : null;
      return alts;
    });
  }

  // 단어가 1~2개면 모두 맞아야 하고, 3개 이상이면 60% 이상 맞으면 결과로 친다
  const need = n => n <= 2 ? n : Math.ceil(n * 0.6);
  // cast[k]가 true인 검색어는 (출연 멤버라서) 이미 맞은 것으로 친다
  const countMatch = (text, terms, cast = []) =>
    terms.reduce((a, alts, k) => a + (cast[k] || alts.some(t => text.includes(t)) ? 1 : 0), 0);

  // 정확히 맞은 검색어 수: 멤버 별명은 입력한 그대로 나왔거나 출연 멤버일 때, 그 밖의 단어는 같은 뜻의 말이 나왔을 때
  const countExact = (text, terms, cast = []) => terms.reduce((a, alts, k) =>
    a + (cast[k] || (alts.exact ? text.includes(alts.exact) : alts.some(t => text.includes(t))) ? 1 : 0), 0);

  // 맞은 검색어들의 가중치 합. 드문 단어(예: 도마뱀)가 맞을수록 흔한 단어(예: 머리)보다 점수가 높다.
  const weigh = (text, terms, cast, w) =>
    terms.reduce((a, alts, k) => a + (cast[k] || alts.some(t => text.includes(t)) ? w[k] : 0), 0);

  // 배열끼리 앞에서부터 비교 (큰 것이 먼저)
  const byRank = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  };

  // 결과: [{ v, scenes: [{i, m}], hits: [세그먼트 번호], rank }] — 관련도순
  function search(DB, q, { year = "" } = {}) {
    const terms = parseQuery(q);
    if (!terms.length) return { terms, results: [] };
    const min = need(terms.length);
    // 단어별 가중치: 전체 대화 조각 중 그 단어가 나오는 조각이 적을수록 크다
    let N = 0;
    const df = terms.map(() => 0);
    for (const v of DB.videos) {
      N += v.n.length;
      for (const text of v.n) terms.forEach((alts, k) => { if (alts.some(t => text.includes(t))) df[k]++; });
    }
    const w = df.map(d => Math.log((N + 1) / (d + 1)));
    const results = [];
    for (const v of DB.videos) {
      if (year && !(v.date || "").startsWith(year)) continue;
      // 검색어 중 이 라이브의 출연 멤버 이름. 멤버 이름만으로 된 검색이면 적용하지 않는다
      // (적용하면 출연한 라이브의 모든 구간이 결과가 되어 버린다)
      let cast = terms.map(alts => alts.some(t => v.cast.has(t)));
      if (cast.every(Boolean)) cast = [];

      // 팬 댓글 장면: 점수 → 좋아요 → 댓글 수 순으로
      const scenes = [];
      v.scenes.forEach((sc, i) => {
        const m = countMatch(sc.n, terms, cast);
        if (m >= min) {
          const score = weigh(sc.n, terms, cast, w), exact = countExact(sc.n, terms, cast);
          // 같은 점수면 출연 멤버 정보가 아니라 글에 그 말이 실제로 나온 쪽을 앞에
          scenes.push({ i, m, score, exact, rank: [exact, score, countExact(sc.n, terms), sc[1], sc[2]] });
        }
      });
      scenes.sort((a, b) => byRank(a.rank, b.rank));

      // 대화 받아쓰기
      const hits = [];
      const hitScore = new Map(), hitExact = new Map(), hitText = new Map();
      for (let i = 0; i < v.n.length; i++) {
        // 검색어 중 하나는 현재 조각 안(또는 다음 조각과의 경계)에 있어야 결과가 한 곳에 몰리지 않는다
        // (출연 멤버라서 맞은 검색어는 기준이 될 수 없다)
        if (!terms.some((alts, k) => !cast[k] && alts.some(t => (v.n[i] + (v.n[i + 1] || "").slice(0, t.length - 1)).includes(t)))) continue;
        const win = (v.n[i - 1] || "") + v.n[i] + (v.n[i + 1] || "");
        if (countMatch(win, terms, cast) < min) continue;
        const score = weigh(win, terms, cast, w), exact = countExact(win, terms, cast);
        // 30초 안에 이어지는 결과는 하나로 묶되, 그중 가장 잘 맞은 줄을 남긴다
        const last = hits[hits.length - 1];
        if (last !== undefined && v.segs[i][0] - v.segs[last][0] < 30) {
          if (exact < hitExact.get(last) || (exact === hitExact.get(last) && score <= hitScore.get(last))) continue;
          hits.pop();
        }
        hits.push(i);
        hitScore.set(i, score);
        hitExact.set(i, exact);
        hitText.set(i, countExact(win, terms));
      }
      // 영상 안에서도 입력한 단어가 그대로 나온 대화 → 점수 높은 대화 순 (같으면 시간순)
      hits.sort((a, b) => hitExact.get(b) - hitExact.get(a) || hitScore.get(b) - hitScore.get(a)
        || hitText.get(b) - hitText.get(a) || a - b);
      // 이 영상에서 가장 정확히 맞은 결과만 남긴다 ("과영이"가 나온 영상이면 다른 별명으로만 맞은 줄은 뺀다)
      const vmax = Math.max(hits.length ? hitExact.get(hits[0]) : 0, scenes.length ? scenes[0].exact : 0);
      for (let k = hits.length - 1; k >= 0; k--) if (hitExact.get(hits[k]) < vmax) hits.splice(k, 1);
      for (let k = scenes.length - 1; k >= 0; k--) if (scenes[k].exact < vmax) scenes.splice(k, 1);
      if (scenes.length || hits.length) {
        const top = scenes[0], topHit = hits[0];
        const exact = Math.max(topHit !== undefined ? hitExact.get(topHit) : 0, top ? top.exact : 0);
        const best = Math.max(topHit !== undefined ? hitScore.get(topHit) : 0, top ? top.score : 0);
        // 입력한 단어가 그대로 나온 쪽(댓글 장면 / 대화)을 카드에서 먼저 보여준다
        const talkFirst = topHit !== undefined && (!top || hitExact.get(topHit) > top.exact);
        const text = Math.max(topHit !== undefined ? hitText.get(topHit) : 0, top ? countExact(v.scenes[top.i].n, terms) : 0);
        results.push({ v, scenes, hits, talkFirst,
          rank: [exact, Math.round(best * 1000), text, top ? v.scenes[top.i][1] : 0, hits.length] });
      }
    }
    results.sort((a, b) => byRank(a.rank, b.rank));
    return { terms, results };
  }

  // 화면에 보이는 순서대로 펼친 목록 (영상마다 팬 장면 → 대화). 품질 점검에서 정답이 몇 번째인지 셀 때 쓴다.
  function flatten(results) {
    const out = [];
    for (const { v, scenes, hits, talkFirst } of results) {
      const sc = scenes.map(s => ({ id: v.id, t: v.scenes[s.i][0], kind: "scene" }));
      const tk = hits.map(i => ({ id: v.id, t: v.segs[i][0], kind: "talk" }));
      out.push(...(talkFirst ? [...tk, ...sc] : [...sc, ...tk]));
    }
    return out;
  }

  return { norm, prepare, parseQuery, countMatch, search, flatten };
})();

if (typeof module !== "undefined") module.exports = RSearch;
