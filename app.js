(() => {
  const DOM = {
    date: document.getElementById('date'),
    lang: document.getElementById('lang'),
    toggles: {
      events: document.getElementById('toggle-events'),
      births: document.getElementById('toggle-births'),
      deaths: document.getElementById('toggle-deaths')
    },
    refresh: document.getElementById('refresh'),
    status: document.getElementById('status'),
    lists: {
      events: document.getElementById('list-events'),
      births: document.getElementById('list-births'),
      deaths: document.getElementById('list-deaths')
    },
    counts: {
      events: document.getElementById('count-events'),
      births: document.getElementById('count-births'),
      deaths: document.getElementById('count-deaths')
    },
    more: {
      events: document.getElementById('more-events'),
      births: document.getElementById('more-births'),
      deaths: document.getElementById('more-deaths')
    },
    panels: {
      events: document.getElementById('events'),
      births: document.getElementById('births'),
      deaths: document.getElementById('deaths')
    },
    shareLink: document.getElementById('share-link')
  };

  const DEFAULT_LIMIT = 20;
  const CHUNK_SIZE = 20;
  const categoryState = {
    events: { items: [], rendered: 0 },
    births: { items: [], rendered: 0 },
    deaths: { items: [], rendered: 0 },
  };
  let observer = null;
  const STORAGE_KEY = 'onthisday-settings-v1';

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toYMD(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}`;
  }

  function fromQuery() {
    const u = new URL(window.location.href);
    const dateStr = u.searchParams.get('date'); // MM-DD
    const lang = u.searchParams.get('lang');
    const toggles = {
      events: u.searchParams.get('events') !== '0',
      births: u.searchParams.get('births') !== '0',
      deaths: u.searchParams.get('deaths') !== '0'
    };
    let date = null;
    if (dateStr && /^\d{2}-\d{2}$/.test(dateStr)) {
      const [mm, dd] = dateStr.split('-').map(Number);
      const now = new Date();
      date = new Date(now.getFullYear(), mm-1, dd);
    }
    return { date, lang, toggles };
  }

  function saveSettings() {
    const settings = {
      date: DOM.date.value,
      lang: DOM.lang.value,
      toggles: {
        events: DOM.toggles.events.checked,
        births: DOM.toggles.births.checked,
        deaths: DOM.toggles.deaths.checked,
      }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function updateShareLink() {
    const d = new Date(DOM.date.value);
    const mm = pad2(d.getMonth()+1);
    const dd = pad2(d.getDate());
    const params = new URLSearchParams({
      date: `${mm}-${dd}`,
      lang: DOM.lang.value,
      events: DOM.toggles.events.checked ? '1' : '0',
      births: DOM.toggles.births.checked ? '1' : '0',
      deaths: DOM.toggles.deaths.checked ? '1' : '0',
    });
    const url = `${location.origin}${location.pathname}?${params.toString()}`;
    DOM.shareLink.href = url;
  }

  function setStatus(msg, type = 'info') {
    if (!msg) {
      DOM.status.hidden = true;
      DOM.status.textContent = '';
      return;
    }
    DOM.status.hidden = false;
    DOM.status.textContent = msg;
    DOM.status.dataset.type = type;
  }

  function showLoading(show) {
    if (show) {
      setStatus('Loading from Wikipedia…', 'loading');
    } else {
      if (DOM.status.dataset.type === 'loading') setStatus('');
    }
  }

  function computeBaseUrl(lang) {
    return `https://${lang}.wikipedia.org/api/rest_v1/feed/onthisday`;
  }

  async function fetchCategory(type, month, day, lang) {
    async function tryPerType(langCode) {
      const base = computeBaseUrl(langCode);
      const url = `${base}/${type}/${month}/${day}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`${type} ${res.status}`);
      const json = await res.json();
      const items = json[type] || (Array.isArray(json) ? json : []);
      return { items, langUsed: langCode, source: 'type' };
    }

    async function tryAll(langCode) {
      const base = computeBaseUrl(langCode);
      const url = `${base}/all/${month}/${day}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`all ${res.status}`);
      const json = await res.json();
      const items = json[type] || [];
      return { items, langUsed: langCode, source: 'all' };
    }

    // Primary: per-type in selected language
    try {
      const res = await tryPerType(lang);
      if (Array.isArray(res.items) && res.items.length) return res;
    } catch (_) {
      // ignore and fallback
    }
    // Fallback 1: all-in-one in selected language
    try {
      const res = await tryAll(lang);
      if (Array.isArray(res.items) && res.items.length) return res;
    } catch (_) {
      // ignore and fallback
    }
    // Fallback 2: English per-type, then all
    if (lang !== 'en') {
      try {
        const res = await tryPerType('en');
        if (Array.isArray(res.items) && res.items.length) return res;
      } catch (_) {}
      try {
        const res = await tryAll('en');
        if (Array.isArray(res.items) && res.items.length) return res;
      } catch (_) {}
    }
    return { items: [], langUsed: lang, source: 'none' };
  }

  function safeTitle(page) {
    return (page?.titles?.normalized) || page?.title || page?.normalizedtitle || 'Article';
  }

  function pageUrl(page) {
    return page?.content_urls?.desktop?.page || page?.content_urls?.mobile?.page ||
      `https://${DOM.lang.value}.wikipedia.org/wiki/${encodeURIComponent(safeTitle(page))}`;
  }

  const summaryCache = new Map(); // key: lang:title -> {extract, thumbnail, description, url}
  const inflight = new Map();
  const catCache = new Map(); // key: lang:title -> [categories]
  const inflightCats = new Map();

  function topPage(item) {
    return item?.pages && item.pages[0] ? item.pages[0] : null;
  }

  async function fetchSummaryByTitle(lang, title) {
    const key = `${lang}:${title}`;
    if (summaryCache.has(key)) return summaryCache.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`summary ${res.status}`);
      const j = await res.json();
      const data = {
        title: j.titles?.normalized || j.title || title,
        extract: j.extract || '',
        description: j.description || '',
        url: j.content_urls?.desktop?.page || j.content_urls?.mobile?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        thumbnail: j.thumbnail?.source || ''
      };
      summaryCache.set(key, data);
      return data;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function fetchCategoriesByTitle(lang, title) {
    const key = `${lang}:${title}`;
    if (catCache.has(key)) return catCache.get(key);
    if (inflightCats.has(key)) return inflightCats.get(key);
    const p = (async () => {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=categories&clshow=!hidden&cllimit=20&titles=${encodeURIComponent(title)}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`categories ${res.status}`);
      const j = await res.json();
      const pages = j?.query?.pages || {};
      const first = Object.values(pages)[0] || {};
      const cats = (first.categories || []).map(c => {
        const t = c.title || '';
        const idx = t.indexOf(':');
        return idx >= 0 ? t.slice(idx + 1) : t;
      }).filter(Boolean);
      catCache.set(key, cats);
      return cats;
    })().finally(() => inflightCats.delete(key));
    inflightCats.set(key, p);
    return p;
  }

  function renderItems(container, items, limit, type) {
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    const max = Math.min(items.length, limit);
    const lang = DOM.lang.value;

    const pending = [];
    for (let i = 0; i < max; i++) {
      const it = items[i];
      const li = document.createElement('li');
      const p = topPage(it);
      const topLink = p ? pageUrl(p) : null;
      const topTitle = p ? safeTitle(p) : null;
      const thumb = p?.thumbnail?.source || '';
      const extract = p?.extract || '';

      li.innerHTML = `
        <div><span class="item-year">${it.year}</span><span class="item-text">${escapeHtml(it.text || '')}</span></div>
        ${topLink ? `<div class="item-links">Related: <a class="title-link" href="${topLink}" target="_blank" rel="noopener">${escapeHtml(topTitle)}</a></div>` : ''}
        <div class="item-extra"></div>
      `;

      const extra = li.querySelector('.item-extra');
      if (p && (thumb || extract)) {
        extra.innerHTML = renderExtraHtml(thumb, extract, topLink, topTitle);
      } else if (p && topTitle) {
        extra.textContent = 'Loading summary…';
        pending.push(
          fetchSummaryByTitle(lang, topTitle)
            .then(sum => {
              extra.innerHTML = renderExtraHtml(sum.thumbnail, sum.extract, sum.url, sum.title);
            })
            .catch(() => { extra.textContent = ''; })
        );
      }

      frag.appendChild(li);
    }
    container.appendChild(frag);
    // Fire and forget; no need to await.
    Promise.allSettled(pending);
  }

  function renderExtraHtml(thumb, extract, url, title) {
    const img = thumb ? `<img class="thumb" src="${thumb}" alt="${escapeHtml(title || 'thumbnail')}" />` : '';
    const ext = extract ? `<div class="extract">${escapeHtml(extract)}</div>` : '';
    if (!img && !ext) return '';
    if (img && ext) {
      return `<div class="item-row">${img}<div>${ext}</div></div>`;
    }
    return img || ext;
  }

  function renderCatsHtml(cats) {
    if (!cats || !cats.length) return '';
    const chips = cats.slice(0, 8).map(c => `<span class="cat-chip">${escapeHtml(c)}</span>`).join('');
    return `<div class="cat-chips">${chips}</div>`;
  }

  // Lazy loading support
  function appendItems(type, start, end) {
    const state = categoryState[type];
    const items = state.items;
    const container = DOM.lists[type];
    const lang = DOM.lang.value;
    const frag = document.createDocumentFragment();
    const max = Math.min(end, items.length);
    const pending = [];

    for (let i = start; i < max; i++) {
      const it = items[i];
      const li = document.createElement('li');
      const p = topPage(it);
      const topLink = p ? pageUrl(p) : null;
      const topTitle = p ? safeTitle(p) : null;
      const thumb = p?.thumbnail?.source || '';
      const extract = p?.extract || '';

      li.innerHTML = `
        <div><span class="item-year">${it.year}</span><span class="item-text">${escapeHtml(it.text || '')}</span></div>
        ${topLink ? `<div class="item-links">Related: <a class="title-link" href="${topLink}" target="_blank" rel="noopener">${escapeHtml(topTitle)}</a></div>` : ''}
        <div class="item-extra"></div>
        <div class="item-cats"></div>
      `;

      const extra = li.querySelector('.item-extra');
      const catsEl = li.querySelector('.item-cats');
      if (p && (thumb || extract)) {
        extra.innerHTML = renderExtraHtml(thumb, extract, topLink, topTitle);
      } else if (p && topTitle) {
        extra.textContent = 'Loading summary…';
        pending.push(
          fetchSummaryByTitle(lang, topTitle)
            .then(sum => { extra.innerHTML = renderExtraHtml(sum.thumbnail, sum.extract, sum.url, sum.title); })
            .catch(() => { extra.textContent = ''; })
        );
      }

      if (type === 'events' && p && topTitle) {
        catsEl.textContent = 'Loading categories…';
        pending.push(
          fetchCategoriesByTitle(lang, topTitle)
            .then(cats => {
              catsEl.innerHTML = renderCatsHtml(cats);
              const spans = catsEl.querySelectorAll('.cat-chip');
              const total = spans.length;
              if (total > 3) {
                for (let i = 3; i < total; i++) spans[i].style.display = 'none';
                const btn = document.createElement('button');
                btn.className = 'chips-more';
                btn.dataset.expanded = 'false';
                const moreLabel = () => `Show more (${total - 3})`;
                const lessLabel = () => 'Show less';
                btn.textContent = moreLabel();
                btn.addEventListener('click', () => {
                  const expanded = btn.dataset.expanded === 'true';
                  if (expanded) {
                    for (let i = 3; i < total; i++) spans[i].style.display = 'none';
                    btn.dataset.expanded = 'false';
                    btn.textContent = moreLabel();
                  } else {
                    for (let i = 3; i < total; i++) spans[i].style.display = '';
                    btn.dataset.expanded = 'true';
                    btn.textContent = lessLabel();
                  }
                });
                catsEl.appendChild(btn);
              }
            })
            .catch(() => { catsEl.textContent = ''; })
        );
      }

      frag.appendChild(li);
    }
    container.appendChild(frag);
    Promise.allSettled(pending);
    state.rendered = max;
    const hasMore = state.rendered < items.length;
    DOM.more[type].hidden = !hasMore;
    return hasMore;
  }

  function resetCategory(type, items) {
    categoryState[type] = { items: items || [], rendered: 0 };
    DOM.lists[type].innerHTML = '';
    DOM.more[type].dataset.type = type;
  }

  function loadMore(type, count = CHUNK_SIZE) {
    const st = categoryState[type];
    if (!st || !st.items.length) return false;
    return appendItems(type, st.rendered, st.rendered + count);
  }

  function setupObserver() {
    if (!('IntersectionObserver' in window)) return;
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const type = e.target.dataset.type;
        if (type) {
          const hasMore = loadMore(type);
          if (!hasMore) observer.unobserve(e.target);
        }
      }
    }, { root: null, rootMargin: '200px 0px', threshold: 0 });

    ['events','births','deaths'].forEach(t => {
      if (DOM.panels[t].style.display === 'none') return;
      if (!DOM.more[t].hidden) observer.observe(DOM.more[t]);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function setCount(type, n) {
    DOM.counts[type].textContent = n ? `${n} items` : '';
  }

  function togglePanel(type, show) {
    DOM.panels[type].style.display = show ? '' : 'none';
  }

  async function refresh() {
    try {
      showLoading(true);
      saveSettings();
      updateShareLink();

      const date = new Date(DOM.date.value);
      const mm = date.getMonth() + 1; // 1-12
      const dd = date.getDate();
      const lang = DOM.lang.value;

      const toGet = ['events', 'births', 'deaths'].filter(t => DOM.toggles[t].checked);
      // hide non-selected panels
      ['events','births','deaths'].forEach(t => togglePanel(t, toGet.includes(t)));

      const results = await Promise.all(
        toGet.map(t => fetchCategory(t, mm, dd, lang)
          .then(res => ({ type: t, res }))
          .catch(err => ({ type: t, err })))
      );

      const fallbackUsed = [];
      for (const r of results) {
        if (r.err) {
          setCount(r.type, 0);
          DOM.lists[r.type].innerHTML = `<li>Failed to load ${r.type}: ${escapeHtml(r.err.message)}</li>`;
          DOM.more[r.type].hidden = true;
          continue;
        }
        const items = r.res.items || [];
        resetCategory(r.type, items);
        setCount(r.type, items.length);
        appendItems(r.type, 0, DEFAULT_LIMIT);
        DOM.more[r.type].onclick = () => { loadMore(r.type); };
        if (r.res.langUsed !== lang) fallbackUsed.push(r.type);
      }
      setupObserver();
      if (fallbackUsed.length) {
        const names = fallbackUsed.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ');
        setStatus(`Showing English results for: ${names} due to missing data in ${lang}.`, 'info');
      } else {
        // Clear any prior info notes, but only if not loading
        if (DOM.status.dataset.type !== 'loading') setStatus('');
      }
    } catch (e) {
      setStatus(`Error: ${e.message}`, 'error');
    } finally {
      showLoading(false);
    }
  }

  function init() {
    // init date to today or from query/localStorage
    const today = new Date();
    const query = fromQuery();
    const saved = loadSettings();

    let initDate = query.date || (saved?.date ? new Date(saved.date) : today);
    // Ensure year is current for nice UX in date input
    initDate = new Date(today.getFullYear(), initDate.getMonth(), initDate.getDate());
    DOM.date.value = toYMD(initDate);

    if (query.lang) DOM.lang.value = query.lang;
    else if (saved?.lang) DOM.lang.value = saved.lang;

    if (query.toggles) {
      DOM.toggles.events.checked = !!query.toggles.events;
      DOM.toggles.births.checked = !!query.toggles.births;
      DOM.toggles.deaths.checked = !!query.toggles.deaths;
    } else if (saved?.toggles) {
      DOM.toggles.events.checked = !!saved.toggles.events;
      DOM.toggles.births.checked = !!saved.toggles.births;
      DOM.toggles.deaths.checked = !!saved.toggles.deaths;
    }

    [DOM.date, DOM.lang,
      DOM.toggles.events, DOM.toggles.births, DOM.toggles.deaths
    ].forEach(el => el.addEventListener('change', () => { refresh(); }));

    DOM.refresh.addEventListener('click', () => { refresh(); });
    updateShareLink();
    refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
