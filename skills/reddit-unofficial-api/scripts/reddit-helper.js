// Reddit unofficial API helper. Paste this whole file as the `expression` of browser_execute_js
// while the active tab is on https://www.reddit.com. It installs `window.redditApi` (read-only)
// and returns a status object. Re-run it after any full page navigation.
// biome-ignore lint/nursery/noFloatingPromises: the IIFE's value is the browser_execute_js result.
(() => {
  if (!/(^|\.)reddit\.com$/.test(location.hostname)) {
    return {
      ok: false,
      error: `Active tab is ${location.hostname || location.href}, not reddit.com. Navigate to https://www.reddit.com first.`,
    };
  }

  const BASE = location.origin;
  const POST_VIEWS = ["hot", "new", "top", "rising", "controversial"];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const clip = (text, max) => {
    if (typeof text !== "string") return text ?? "";
    if (max == null || max < 0 || text.length <= max) return text;
    return `${text.slice(0, max)}… [+${text.length - max} chars]`;
  };
  const iso = (utc) => (typeof utc === "number" ? new Date(utc * 1000).toISOString() : null);
  const cleanSub = (name) =>
    String(name || "")
      .trim()
      .replace(/^\/?r\//i, "")
      .replace(/\/.*$/, "");

  async function get(path, params = {}) {
    const url = new URL(path, BASE);
    url.searchParams.set("raw_json", "1");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (!resp.ok || data === undefined) {
      const reason = data?.reason || data?.message || resp.statusText || "non-JSON response";
      const err = new Error(`HTTP ${resp.status} ${reason} for ${url.pathname}`);
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  // Accepts a post URL (www/old/new/shreddit, redd.it, /r/x/s/<share> links), a t3_ fullname, or a bare id.
  async function resolvePost(input) {
    let s = String(input || "").trim();
    if (!s) throw new Error("Missing post url or id");
    if (/^t3_[a-z0-9]+$/i.test(s)) return { id: s.slice(3) };
    if (/^[a-z0-9]{4,10}$/i.test(s)) return { id: s };
    if (/\/s\/[A-Za-z0-9]+/.test(s)) {
      // Share links redirect to the canonical permalink.
      const resp = await fetch(new URL(s, BASE), { credentials: "include" });
      s = resp.url;
    }
    const m = s.match(/\/comments\/([a-z0-9]+)(?:\/[^/?#]*\/([a-z0-9]+))?/i);
    if (m) return { id: m[1], commentId: m[2] };
    const short = s.match(/redd\.it\/([a-z0-9]+)/i);
    if (short) return { id: short[1] };
    throw new Error(`Could not parse a post id from: ${input}`);
  }

  function slimPost(d, bodyChars) {
    return {
      id: d.id,
      name: d.name,
      subreddit: d.subreddit,
      title: d.title,
      author: d.author,
      score: d.score,
      upvote_ratio: d.upvote_ratio,
      num_comments: d.num_comments,
      created: iso(d.created_utc),
      flair: d.link_flair_text || null,
      is_self: d.is_self,
      over_18: d.over_18,
      stickied: d.stickied,
      locked: d.locked,
      permalink: `https://www.reddit.com${d.permalink}`,
      url: d.is_self ? null : d.url_overridden_by_dest || d.url,
      selftext: clip(d.selftext, bodyChars),
    };
  }

  function slimComment(d, depth, bodyChars) {
    return {
      id: d.name,
      parent_id: d.parent_id,
      depth,
      author: d.author,
      score: d.score,
      created: iso(d.created_utc),
      is_submitter: d.is_submitter,
      stickied: d.stickied,
      body: clip(d.body, bodyChars),
    };
  }

  function slimSubreddit(d, textChars) {
    return {
      name: d.display_name,
      fullname: d.name,
      title: d.title,
      url: `https://www.reddit.com${d.url}`,
      subscribers: d.subscribers,
      active_users: d.active_user_count ?? d.accounts_active ?? null,
      created: iso(d.created_utc),
      type: d.subreddit_type,
      over_18: d.over18,
      public_description: clip(d.public_description, textChars),
      description: clip(d.description, textChars),
      submit_text: clip(d.submit_text, textChars),
    };
  }

  function listing(data, map) {
    const children = data?.data?.children ?? [];
    return { after: data?.data?.after ?? null, count: children.length, items: children.map(map) };
  }

  // Walk a comment tree. Collects `more` stubs so callers can expand them.
  function walk(children, depth, opts, out, mores) {
    for (const child of children || []) {
      if (child.kind === "more") {
        mores.push({
          parent_id: child.data.parent_id,
          depth,
          count: child.data.count,
          children: child.data.children,
        });
        continue;
      }
      if (child.kind !== "t1") continue;
      const node = slimComment(child.data, depth, opts.commentChars);
      out.push(node);
      const replies = child.data.replies?.data?.children;
      if (replies?.length) {
        if (opts.nested) {
          if (depth + 1 <= opts.depth) {
            node.replies = [];
            walk(replies, depth + 1, opts, node.replies, mores);
            if (node.replies.length === 0) delete node.replies;
          } else {
            node.hidden_replies = replies.length;
          }
        } else {
          walk(replies, depth + 1, opts, out, mores);
        }
      }
    }
  }

  async function fetchThread(input, { sort, limit, depth }) {
    const ref = await resolvePost(input);
    const params = { sort, limit, depth };
    if (ref.commentId) Object.assign(params, { comment: ref.commentId, context: 3 });
    const data = await get(`/comments/${ref.id}.json`, params);
    if (!Array.isArray(data) || data.length < 2) throw new Error("Unexpected post response shape");
    return {
      ref,
      post: data[0]?.data?.children?.[0]?.data,
      comments: data[1]?.data?.children ?? [],
    };
  }

  const api = {
    version: 1,

    /** Who is logged in (null username when logged out). */
    async session() {
      const me = await get("/api/me.json");
      return { loggedIn: Boolean(me?.data?.name), username: me?.data?.name ?? null };
    },

    /** Post + nested comment tree (trimmed). */
    async getPost({
      url,
      id,
      sort = "top",
      limit = 50,
      depth = 4,
      bodyChars = 4000,
      commentChars = 800,
    } = {}) {
      const t = await fetchThread(url ?? id, { sort, limit, depth: depth + 1 });
      const comments = [];
      const mores = [];
      walk(t.comments, 0, { nested: true, depth, commentChars }, comments, mores);
      return {
        post: slimPost(t.post, bodyChars),
        focused_comment: t.ref.commentId ? `t1_${t.ref.commentId}` : null,
        comments,
        more_comments: mores.reduce((n, m) => n + (m.count || 0), 0),
      };
    },

    /** Flat comment list; expands `more` stubs via /api/morechildren. */
    async getComments({
      url,
      id,
      sort = "top",
      limit = 500,
      expandMore = true,
      maxMoreRequests = 5,
      commentChars = 1500,
      minScore,
    } = {}) {
      const t = await fetchThread(url ?? id, { sort, limit });
      const flat = [];
      const mores = [];
      walk(t.comments, 0, { nested: false, commentChars }, flat, mores);

      let requests = 0;
      let unexpanded = 0;
      let continueThreads = 0;
      const depthOf = new Map(flat.map((c) => [c.id, c.depth]));
      const queue = [];
      for (const m of mores) {
        // id "_" with count 0 is a "continue this thread" link: needs a separate permalink fetch.
        if (m.children?.length) queue.push(...m.children);
        else continueThreads += 1;
      }
      while (expandMore && queue.length && requests < maxMoreRequests) {
        const batch = queue.splice(0, 100);
        requests += 1;
        if (requests > 1) await sleep(400);
        const res = await get("/api/morechildren.json", {
          api_type: "json",
          link_id: t.post.name,
          sort,
          children: batch.join(","),
        });
        for (const thing of res?.json?.data?.things ?? []) {
          if (thing.kind === "more") {
            if (thing.data.children?.length) queue.push(...thing.data.children);
            else continueThreads += 1;
            continue;
          }
          if (thing.kind !== "t1") continue;
          const d = thing.data;
          const depth = d.depth ?? (depthOf.has(d.parent_id) ? depthOf.get(d.parent_id) + 1 : 0);
          depthOf.set(d.name, depth);
          flat.push(slimComment(d, depth, commentChars));
        }
      }
      unexpanded += queue.length;

      const comments =
        typeof minScore === "number" ? flat.filter((c) => c.score >= minScore) : flat;
      return {
        post: {
          id: t.post.id,
          title: t.post.title,
          subreddit: t.post.subreddit,
          num_comments: t.post.num_comments,
        },
        count: comments.length,
        unexpanded_ids: unexpanded,
        continue_threads: continueThreads,
        more_requests: requests,
        comments,
      };
    },

    /** view: about | rules | hot | new | top | rising | controversial */
    async getSubreddit({
      name,
      view = "hot",
      limit = 25,
      t = "day",
      after,
      bodyChars = 300,
      textChars = 1500,
    } = {}) {
      const sub = cleanSub(name);
      if (!sub) throw new Error("Missing subreddit name");
      if (view === "about")
        return slimSubreddit((await get(`/r/${sub}/about.json`)).data, textChars);
      if (view === "rules") {
        const data = await get(`/r/${sub}/about/rules.json`);
        return {
          subreddit: sub,
          rules: (data.rules ?? []).map((r) => ({
            name: r.short_name,
            applies_to: r.kind,
            description: clip(r.description, textChars),
          })),
        };
      }
      if (!POST_VIEWS.includes(view)) throw new Error(`Unknown view "${view}"`);
      const params = { limit, after };
      if (view === "top" || view === "controversial") params.t = t;
      const data = await get(`/r/${sub}/${view}.json`, params);
      return { subreddit: sub, view, ...listing(data, (c) => slimPost(c.data, bodyChars)) };
    },

    /** type: link (posts) | sr (subreddits). sort: relevance | hot | top | new | comments */
    async search({
      q,
      subreddit,
      sort = "relevance",
      t = "all",
      limit = 25,
      after,
      type = "link",
      bodyChars = 300,
    } = {}) {
      if (!q) throw new Error("Missing query q");
      if (type === "sr") {
        const data = await get("/subreddits/search.json", { q, limit, after });
        return { query: q, type, ...listing(data, (c) => slimSubreddit(c.data, bodyChars)) };
      }
      const sub = cleanSub(subreddit);
      const path = sub ? `/r/${sub}/search.json` : "/search.json";
      const data = await get(path, {
        q,
        sort,
        t,
        limit,
        after,
        restrict_sr: sub ? "on" : undefined,
        type: "link",
      });
      return {
        query: q,
        subreddit: sub || null,
        sort,
        t,
        ...listing(data, (c) => slimPost(c.data, bodyChars)),
      };
    },

    /** Escape hatch for other read-only .json endpoints, e.g. raw('/user/spez/about.json'). */
    async raw(path, params = {}) {
      return get(path, params);
    },
  };

  // Return errors as values: thrown errors surface as opaque CDP exceptions.
  for (const [key, fn] of Object.entries(api)) {
    if (typeof fn !== "function") continue;
    api[key] = async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        return { error: e?.message || String(e), status: e?.status ?? null };
      }
    };
  }

  window.redditApi = api;
  return {
    ok: true,
    installed: "window.redditApi",
    version: api.version,
    methods: Object.keys(api).filter((k) => k !== "version"),
  };
})();
