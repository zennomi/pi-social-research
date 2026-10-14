type RawObject = Record<string, unknown>;

export interface SlimUser {
  id: string;
  username: string;
  name: string;
  url: string;
  bio?: string | undefined;
  location?: string | undefined;
  website?: string | undefined;
  created_at?: string | undefined;
  followers?: number | undefined;
  following?: number | undefined;
  tweets?: number | undefined;
  verified?: boolean | undefined;
  affiliation?: string | undefined;
  protected?: boolean | undefined;
}

export interface SlimTweet {
  id: string;
  url: string;
  text: string;
  created_at?: string | undefined;
  author?: Pick<SlimUser, "id" | "username" | "name" | "verified" | "followers"> | undefined;
  lang?: string | undefined;
  metrics: Record<string, number>;
  reply_to?: { tweet_id?: string | undefined; username?: string | undefined } | undefined;
  conversation_id?: string | undefined;
  pinned?: boolean | undefined;
  media?: { type: string; url: string; duration_s?: number | undefined }[] | undefined;
  links?: string[] | undefined;
  article?: { title?: string | undefined; preview?: string | undefined } | undefined;
  quoted?: SlimTweet | undefined;
  retweet_of?: SlimTweet | undefined;
}

export function object(value: unknown): RawObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawObject)
    : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => object(current)[key], value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "" || typeof value === "boolean")
    return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Remove empty optional values, preserving zero counts. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) =>
        v !== undefined &&
        v !== null &&
        v !== false &&
        v !== "" &&
        !(Array.isArray(v) && v.length === 0)
    )
  ) as T;
}

export function capText(text: string, limit = 4000): string {
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : text;
}

function expand(text: string, urls: unknown[]): string {
  for (const item of urls) {
    const u = object(item);
    if (typeof u.url === "string" && typeof u.expanded_url === "string") {
      text = text.split(u.url).join(u.expanded_url);
    }
  }
  return text;
}

export function normalizeUser(raw: unknown): SlimUser | undefined {
  const r = object(at(raw, "result") ?? raw);
  const legacy = object(r.legacy ?? r);
  const core = object(r.core ?? legacy);
  const id = str(r.rest_id ?? legacy.id_str);
  const username = str(core.screen_name ?? legacy.screen_name);
  if (!id || !username) return undefined;
  const entities = object(at(r, "profile_bio", "entities") ?? legacy.entities);
  const website = str(
    at(array(at(entities, "url", "urls"))[0], "expanded_url") ??
      at(r, "website", "url") ??
      legacy.url
  );
  const bio = expand(
    str(at(r, "profile_bio", "description") ?? legacy.description) ?? "",
    array(at(entities, "description", "urls"))
  );
  return compact({
    id,
    username,
    name: str(core.name ?? legacy.name) ?? username,
    url: `https://x.com/${username}`,
    bio: bio ? capText(bio, 1500) : undefined,
    website,
    location: str(at(r, "location", "location") ?? legacy.location),
    created_at: iso(core.created_at ?? legacy.created_at),
    followers: num(at(r, "relationship_counts", "followers") ?? legacy.followers_count),
    following: num(at(r, "relationship_counts", "following") ?? legacy.friends_count),
    tweets: num(at(r, "tweet_counts", "tweets") ?? legacy.statuses_count),
    verified:
      Boolean(
        at(r, "verification", "is_blue_verified") ||
          at(r, "verification", "verified") ||
          r.is_blue_verified ||
          legacy.ext_is_blue_verified ||
          legacy.verified
      ) || undefined,
    affiliation: str(
      at(r, "identity_profile_labels_highlighted_label", "label", "description") ??
        at(r, "affiliates_highlighted_label", "label", "description")
    ),
    protected: Boolean(at(r, "privacy", "protected") ?? legacy.protected) || undefined,
  });
}

export function unwrapTweet(raw: unknown): RawObject {
  let r = object(raw);
  for (let i = 0; i < 5; i++) {
    if (r.result) r = object(r.result);
    else if (r.__typename === "TweetWithVisibilityResults") r = object(r.tweet);
    else break;
  }
  return r;
}

export function normalizeTweet(raw: unknown, depth = 0): SlimTweet | undefined {
  const r = unwrapTweet(raw);
  const legacy = object(r.legacy);
  const id = str(r.rest_id ?? legacy.id_str);
  if (!id || (!legacy.full_text && legacy.full_text !== "")) return undefined;
  const user = normalizeUser(at(r, "core", "user_results") ?? at(r, "core", "user_result"));
  const note = object(at(r, "note_tweet", "note_tweet_results", "result"));
  const urls = array(at(note, "entity_set", "urls") ?? at(legacy, "entities", "urls"));
  const rawMedia = array(
    at(legacy, "extended_entities", "media") ?? at(legacy, "entities", "media")
  );
  let text = str(note.text) ?? str(legacy.full_text) ?? "";
  for (const m of rawMedia) {
    const token = str(at(m, "url"));
    if (token && text.trimEnd().endsWith(token))
      text = text.trimEnd().slice(0, -token.length).trimEnd();
  }
  text = expand(text, urls);
  const media = rawMedia.flatMap((value) => {
    const m = object(value);
    const mp4 = array(at(m, "video_info", "variants"))
      .map(object)
      .filter((v) => v.content_type === "video/mp4")
      .sort((a, b) => (num(b.bitrate) ?? 0) - (num(a.bitrate) ?? 0))[0];
    const url = str(mp4?.url ?? m.media_url_https);
    if (!url) return [];
    const duration = num(at(m, "video_info", "duration_millis"));
    return [
      compact({
        type: m.type === "animated_gif" ? "gif" : (str(m.type) ?? "photo"),
        url,
        duration_s: duration === undefined ? undefined : duration / 1000,
      }),
    ];
  });
  const metrics: Record<string, number> = {};
  for (const [name, key] of Object.entries({
    likes: "favorite_count",
    retweets: "retweet_count",
    replies: "reply_count",
    quotes: "quote_count",
    bookmarks: "bookmark_count",
  })) {
    const value = num(legacy[key]);
    if (value !== undefined) metrics[name] = value;
  }
  const views = num(at(r, "view_count_info", "count") ?? at(r, "views", "count"));
  if (views !== undefined) metrics.views = views;
  const reply = compact({
    tweet_id: str(legacy.in_reply_to_status_id_str),
    username: str(legacy.in_reply_to_screen_name),
  });
  const article = object(at(r, "article", "article_results", "result"));
  return compact({
    id,
    url: `https://x.com/${user?.username ?? "i/web"}/status/${id}`,
    created_at: iso(legacy.created_at),
    author: user
      ? compact({
          id: user.id,
          username: user.username,
          name: user.name,
          verified: user.verified,
          followers: user.followers,
        })
      : undefined,
    text: capText(text, depth > 0 ? 1500 : 4000),
    lang: str(legacy.lang),
    metrics,
    reply_to: Object.keys(reply).length > 0 ? reply : undefined,
    conversation_id: str(legacy.conversation_id_str),
    media,
    links: [
      ...new Set(
        urls.map((u) => str(at(u, "expanded_url"))).filter((v): v is string => Boolean(v))
      ),
    ],
    article: article.title
      ? compact({
          title: str(article.title),
          preview: capText(str(article.preview_text) ?? "", 1000),
        })
      : undefined,
    quoted:
      depth === 0
        ? normalizeTweet(r.quoted_tweet_results ?? r.quoted_status_result, depth + 1)
        : undefined,
    retweet_of:
      depth === 0
        ? normalizeTweet(
            legacy.retweeted_status_results ??
              legacy.retweeted_status_result ??
              r.retweeted_status_results ??
              r.retweeted_status_result,
            depth + 1
          )
        : undefined,
  });
}

/** Find typed provider results; callers normalize them before returning any data. */
export function findObjects(raw: unknown, typename: string): RawObject[] {
  const results: RawObject[] = [];
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const r = object(value);
    if (r.__typename === typename) results.push(r);
    for (const child of Object.values(r)) if (child && typeof child === "object") walk(child);
  }
  walk(raw);
  return results;
}

export function extractTimeline(
  raw: unknown,
  requireTimeline = false
): {
  tweets: SlimTweet[];
  users: SlimUser[];
  next_cursor?: string | undefined;
} {
  const tweets = new Map<string, SlimTweet>();
  const users = new Map<string, SlimUser>();
  let cursor: string | undefined;
  let recognized = false;
  function item(rawItem: unknown, pinned = false): void {
    const r = object(rawItem);
    if (r.promotedMetadata || r.promoted_metadata) return;
    if (r.__typename === "TimelineTweet") {
      const tweet = normalizeTweet(r.tweet_results ?? r.tweetResult);
      if (tweet)
        tweets.set(tweet.id, pinned ? { ...tweet, pinned: true } : (tweets.get(tweet.id) ?? tweet));
      return;
    }
    if (r.__typename === "TimelineUser") {
      const user = normalizeUser(r.user_results ?? r.userResult ?? r.user_result);
      if (user) users.set(user.id, user);
      return;
    }
    for (const key of ["content", "item", "itemContent", "item_content"])
      if (r[key]) item(r[key], pinned);
    for (const child of array(r.items)) item(child, pinned);
  }
  function entry(value: unknown, pinned = false): void {
    const r = object(value);
    const id = str(r.entry_id ?? r.entryId) ?? "";
    if (id.startsWith("promoted-") || id.startsWith("who-to-follow-")) return;
    const content = object(r.content);
    if ((content.cursor_type ?? content.cursorType) === "Bottom") {
      cursor = str(content.value);
      return;
    }
    item(content, pinned);
  }
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    const r = object(value);
    if (Array.isArray(r.instructions)) {
      recognized = true;
      for (const value of r.instructions) {
        const instruction = object(value);
        for (const e of array(instruction.entries)) entry(e);
        if (instruction.entry)
          entry(instruction.entry, instruction.__typename === "TimelinePinEntry");
        for (const e of array(instruction.moduleItems ?? instruction.module_items)) item(e);
      }
      return;
    }
    for (const child of Object.values(r)) if (child && typeof child === "object") walk(child);
  }
  walk(raw);
  if (requireTimeline && !recognized) {
    throw new Error("X API timeline unavailable or unrecognized response schema.");
  }
  return {
    tweets: [...tweets.values()],
    users: [...users.values()],
    ...compact({ next_cursor: cursor }),
  };
}

export function normalizeCommunity(raw: unknown): object | undefined {
  const r = object(at(raw, "result") ?? raw);
  const id = str(r.rest_id);
  if (!id || !r.name) return undefined;
  return compact({
    id,
    url: `https://x.com/i/communities/${id}`,
    name: str(r.name),
    description: capText(str(r.description) ?? "", 2000),
    members: num(r.member_count),
    moderators: num(r.moderator_count),
    created_at: iso(r.created_at),
    join_policy: str(r.join_policy),
    topic: str(at(r, "community_topic", "topic_name") ?? at(r, "community_topic", "name")),
    nsfw: r.is_nsfw === true || undefined,
    rules: array(r.rules).map((v) =>
      compact({
        name: str(at(v, "name")),
        description: capText(str(at(v, "description")) ?? "", 1000),
      })
    ),
  });
}

export function normalizeTrends(raw: unknown): object[] {
  return array(at(raw, "modules")).flatMap((value) => {
    const r = object(at(value, "trend"));
    const name = str(r.name);
    return name ? [compact({ name, rank: num(r.rank), query: str(at(r, "target", "query")) })] : [];
  });
}

export function normalizeListSearch(raw: unknown): object[] {
  return array(at(raw, "lists")).flatMap((value) => {
    const r = object(value);
    const id = str(r.object_id);
    return id
      ? [
          compact({
            id,
            url: `https://x.com/i/lists/${id}`,
            name: str(r.topic),
            description: capText(str(r.supporting_text) ?? "", 1000),
          }),
        ]
      : [];
  });
}

export function articleToMarkdown(
  raw: unknown
): { title: string; markdown: string; author?: string | undefined } | undefined {
  const tweet = findObjects(raw, "Tweet").find((t) =>
    at(t, "article", "article_results", "result", "content_state")
  );
  if (!tweet) return undefined;
  const article = object(at(tweet, "article", "article_results", "result"));
  const title = str(article.title) ?? "X article";
  const user = normalizeUser(at(tweet, "core", "user_results") ?? at(tweet, "core", "user_result"));
  const blocks = array(at(article, "content_state", "blocks"));
  const entityMap = at(article, "content_state", "entityMap");
  const entities = new Map<string, RawObject>();
  if (Array.isArray(entityMap)) {
    for (const entity of entityMap)
      entities.set(String(at(entity, "key")), object(at(entity, "value")));
  } else {
    for (const [key, entity] of Object.entries(object(entityMap)))
      entities.set(key, object(entity));
  }
  const body = blocks
    .flatMap((value) => {
      const block = object(value);
      let text = str(block.text);
      if (!text || block.type === "atomic") return [];
      // Draft.js offsets use UTF-16 code units. Insert from right to left to preserve offsets.
      const ranges = array(block.entityRanges)
        .map(object)
        .sort((a, b) => (num(b.offset) ?? 0) - (num(a.offset) ?? 0));
      let boundary = text.length;
      for (const range of ranges) {
        const entity = entities.get(String(range.key));
        const url = str(at(entity, "data", "url"));
        const offset = num(range.offset);
        const length = num(range.length);
        if (
          entity?.type !== "LINK" ||
          !url ||
          !/^(https?:\/\/|mailto:)/i.test(url) ||
          offset === undefined ||
          length === undefined ||
          !Number.isInteger(offset) ||
          !Number.isInteger(length) ||
          offset < 0 ||
          length <= 0 ||
          offset + length > boundary
        )
          continue;
        const label: string = text
          .slice(offset, offset + length)
          .replace(/([\\[\\]\\\\])/g, "\\\\$1");
        const target = url.replaceAll("(", "%28").replaceAll(")", "%29");
        text = `${text.slice(0, offset)}[${label}](${target})${text.slice(offset + length)}`;
        boundary = offset;
      }
      const prefix: Record<string, string> = {
        "header-one": "# ",
        "header-two": "## ",
        "header-three": "### ",
        "unordered-list-item": "- ",
        "ordered-list-item": "1. ",
        blockquote: "> ",
      };
      return [`${prefix[String(block.type)] ?? ""}${text}`];
    })
    .join("\n\n");
  return compact({
    title,
    author: user?.username,
    markdown: `# ${title}\n\n${user ? `By @${user.username}\n\n` : ""}${body}`,
  });
}
