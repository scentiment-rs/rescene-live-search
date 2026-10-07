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

  // data.json을 받은 뒤 한 번 호출: 동의어 사전과 검색용 정규화 텍스트를 만든다
  function prepare(DB) {
    synMap = new Map();
    memberGroups = new Map();
    for (const group of DB.synonyms) {
      const g = group.map(norm);
      for (const n of g) synMap.set(n, g);
      memberGroups.set(group[0], g);
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

  function parseQuery(q) {
    const words = q.trim().split(/\s+/).map(norm).filter(Boolean);
    const kept = words.filter(w => !STOP.has(w)).map(stem).filter(w => !STOP.has(w));
    return [...new Set(kept.length ? kept : words)].map(t => synMap.get(t) || [t]);
  }

  // 단어가 1~2개면 모두 맞아야 하고, 3개 이상이면 60% 이상 맞으면 결과로 친다
  const need = n => n <= 2 ? n : Math.ceil(n * 0.6);
  // cast[k]가 true인 검색어는 (출연 멤버라서) 이미 맞은 것으로 친다
  const countMatch = (text, terms, cast = []) =>
    terms.reduce((a, alts, k) => a + (cast[k] || alts.some(t => text.includes(t)) ? 1 : 0), 0);

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
        if (m >= min) scenes.push({ i, m, score: weigh(sc.n, terms, cast, w), rank: [weigh(sc.n, terms, cast, w), sc[1], sc[2]] });
      });
      scenes.sort((a, b) => byRank(a.rank, b.rank));

      // 대화 받아쓰기
      const hits = [];
      const hitScore = new Map();
      for (let i = 0; i < v.n.length; i++) {
        // 검색어 중 하나는 현재 조각 안(또는 다음 조각과의 경계)에 있어야 결과가 한 곳에 몰리지 않는다
        // (출연 멤버라서 맞은 검색어는 기준이 될 수 없다)
        if (!terms.some((alts, k) => !cast[k] && alts.some(t => (v.n[i] + (v.n[i + 1] || "").slice(0, t.length - 1)).includes(t)))) continue;
        const win = (v.n[i - 1] || "") + v.n[i] + (v.n[i + 1] || "");
        if (countMatch(win, terms, cast) < min) continue;
        // 15초 안에 이어지는 결과는 하나로 묶는다
        if (hits.length && v.segs[i][0] - v.segs[hits[hits.length - 1]][0] < 15) continue;
        hits.push(i);
        hitScore.set(i, weigh(win, terms, cast, w));
      }
      // 영상 안에서도 점수가 높은 대화부터 (같으면 시간순)
      hits.sort((a, b) => hitScore.get(b) - hitScore.get(a) || a - b);
      if (scenes.length || hits.length) {
        const top = scenes[0];
        const best = Math.max(hits.length ? hitScore.get(hits[0]) : 0, top ? top.score : 0);
        results.push({ v, scenes, hits, rank: [Math.round(best * 1000), top ? v.scenes[top.i][1] : 0, hits.length] });
      }
    }
    results.sort((a, b) => byRank(a.rank, b.rank));
    return { terms, results };
  }

  // 화면에 보이는 순서대로 펼친 목록 (영상마다 팬 장면 → 대화). 품질 점검에서 정답이 몇 번째인지 셀 때 쓴다.
  function flatten(results) {
    const out = [];
    for (const { v, scenes, hits } of results) {
      for (const s of scenes) out.push({ id: v.id, t: v.scenes[s.i][0], kind: "scene" });
      for (const i of hits) out.push({ id: v.id, t: v.segs[i][0], kind: "talk" });
    }
    return out;
  }

  return { norm, prepare, parseQuery, countMatch, search, flatten };
})();

if (typeof module !== "undefined") module.exports = RSearch;
