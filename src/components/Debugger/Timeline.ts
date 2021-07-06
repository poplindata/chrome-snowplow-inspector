import { Entry } from "har-format";
import { default as m, Vnode } from "mithril";
import { trackerAnalytics } from "../../ts/analytics";
import { protocol } from "../../ts/protocol";
import { BeaconValidity, IBeaconSummary, ITimeline } from "../../ts/types";
import { b64d, hash, tryb64 } from "../../ts/util";
import { validate } from "../../ts/validator";

const COLLECTOR_COLOURS = [
  "turquoise",
  "purple",
  "dark",
  "red",
  "yellow",
  "blue",
  "light",
];
const SEEN_COLLECTORS = new Map();

const colourOf = (beacon: IBeaconSummary) => {
  const id = beacon.collector + beacon.appId;

  if (!SEEN_COLLECTORS.has(id)) {
    SEEN_COLLECTORS.set(
      id,
      COLLECTOR_COLOURS[SEEN_COLLECTORS.size % COLLECTOR_COLOURS.length || 0]
    );
  }

  return SEEN_COLLECTORS.get(id);
};

const filterRequest = (beacon: IBeaconSummary, filter?: RegExp) => {
  return (
    typeof filter === "undefined" ||
    (beacon.appId && filter.test(beacon.appId)) ||
    filter.test(beacon.collector) ||
    filter.test(beacon.eventName) ||
    filter.test(beacon.method) ||
    (beacon.page && filter.test(beacon.page)) ||
    (Array.from(beacon.payload.values()) as string[]).filter((x) => {
      let decoded: string | null;
      try {
        decoded = b64d(x);
      } catch (e) {
        decoded = null;
      }

      return filter.test(decoded || "") || filter.test(x);
    }).length > 0
  );
};

const nameEvent = (params: Map<string, string>): string => {
  const event = params.get("e") || "Unknown Event";

  let result: string;
  const eventTypes = protocol.paramMap.e.values;
  switch (event) {
    case "se":
      return eventTypes[event] + ": " + params.get("se_ca");
    case "ue":
      const payload = params.get("ue_pr") || params.get("ue_px") || "";
      let sdeName = "Unstructured";
      let sde = null;

      try {
        sde = JSON.parse(tryb64(payload));
      } catch (e) {
        sde = JSON.parse(payload);
      } finally {
        if (
          typeof sde === "object" &&
          sde !== null &&
          sde.hasOwnProperty("schema") &&
          sde.hasOwnProperty("data")
        ) {
          sdeName = sde.data.schema || "Unstructured";
          if (sdeName.startsWith("iglu:")) {
            sdeName = sdeName.split("/")[1];
          }
        }
      }

      return "SD Event: " + sdeName;
    case "pp":
    case "pv":
    case "ti":
    case "tr":
      return eventTypes[event];
    default:
      return event;
  }
};

const validateEvent = (params: Map<string, string>): BeaconValidity => {
  let unrec = false;
  let valid = true;
  let status;

  if (params.get("e") === "ue") {
    const payload = params.get("ue_pr") || params.get("ue_px") || "";

    try {
      const sde = JSON.parse(tryb64(payload));
      if (
        typeof sde === "object" &&
        sde !== null &&
        sde.hasOwnProperty("schema") &&
        sde.hasOwnProperty("data")
      ) {
        status = validate(sde.schema, sde.data);
        unrec = unrec || status.location === null;
        valid = valid && status.valid;

        status = validate(sde.data.schema, sde.data.data);
        unrec = unrec || status.location === null;
        valid = valid && status.valid;
      } else {
        unrec = true;
        valid = false;
      }
    } catch (e) {
      console.log(e);
    }
  }

  if (params.has("cx") || params.has("co")) {
    const payload = params.get("co") || params.get("cx") || "";

    try {
      const ctx = JSON.parse(tryb64(payload));
      if (
        typeof ctx === "object" &&
        ctx !== null &&
        ctx.hasOwnProperty("schema") &&
        ctx.hasOwnProperty("data")
      ) {
        status = validate(ctx.schema, ctx.data);
        unrec = unrec || status.location === null;
        valid = valid && status.valid;

        ctx.data.forEach((c: { schema: string; data: object }) => {
          status = validate(c.schema, c.data);
          unrec = unrec || status.location === null;
          valid = valid && status.valid;
        });
      } else {
        unrec = true;
        valid = false;
      }
    } catch (e) {
      console.log(e);
    }
  }

  return valid ? "Valid" : unrec ? "Unrecognised" : "Invalid";
};

const summariseBeacons = (
  entry: Entry,
  index: number,
  filter?: RegExp
): IBeaconSummary[] => {
  const reqs = extractRequests(entry, index);
  const [[id, collector, method], requests] = reqs;

  const results = [];

  for (const [i, req] of requests.entries()) {
    const result: IBeaconSummary = {
      appId: req.get("aid"),
      collector,
      eventName: nameEvent(req),
      id: `#${id}-${i}`,
      method,
      page: req.get("url"),
      payload: new Map(req),
      time: new Date(
        parseInt(req.get("stm") || req.get("dtm") || "", 10) || +new Date()
      ).toJSON(),
      validity: validateEvent(req),
    };

    trackerAnalytics(collector, result.page, result.appId);

    if (filterRequest(result, filter)) {
      results.push(result);
    }
  }

  return results;
};

const getPageUrl = (entries: Entry[]) => {
  const urls = entries.reduce((ac, cv) => {
    const page = cv.request.headers.filter((x) => /referr?er/i.test(x.name))[0];
    if (page) {
      const pageVal = page.value;
      ac[pageVal] = (ac[pageVal] || 0) + 1;
    }
    return ac;
  }, {} as { [referrer: string]: number });

  let url: string | null = null;
  let max = -1;
  for (const p in urls) {
    if (urls[p] >= max) {
      (url = p), (max = urls[p]);
    }
  }

  if (url !== null) {
    return new URL(url);
  }

  return url;
};

const extractRequests = (
  entry: Entry,
  index: number
): [[string, string, string], Map<string, string>[]] => {
  const req = entry.request;
  const id =
    entry.pageref +
    hash(new Date(entry.startedDateTime).toJSON() + req.url + index);
  const collector = new URL(req.url).hostname;
  const method = req.method;
  const beacons = [];

  const nuid = entry.request.cookies.filter((x) => x.name === "sp")[0];
  const ua = entry.request.headers.find(
    (x) => x.name.toLowerCase() === "user-agent"
  );
  const lang = entry.request.headers.find(
    (x) => x.name.toLowerCase() === "accept-language"
  );
  const refr = entry.request.headers.find(
    (x) => x.name.toLowerCase() === "referer"
  );

  if (req.method === "POST") {
    try {
      if (req.postData === undefined || !req.postData.text) {
        throw new Error("POST request unexpectedly had no body.");
      }

      const payload = JSON.parse(req.postData.text);

      for (const pl of payload.data) {
        const beacon: Map<string, string> = new Map(Object.entries(pl));
        if (nuid && !beacon.has("nuid")) {
          beacon.set("nuid", nuid.value);
        }
        if (ua && !beacon.has("ua")) {
          beacon.set("ua", ua.value);
        }
        if (lang && !beacon.has("lang")) {
          beacon.set("lang", lang.value);
        }
        if (refr && !beacon.has("url")) {
          beacon.set("url", refr.value);
        }

        beacons.push(beacon);
      }
    } catch (e) {
      console.log("=================");
      console.log(e);
      console.log(JSON.stringify(req));
      console.log("=================");
    }
  } else {
    const beacon: Map<string, string> = new Map();
    new URL(req.url).searchParams.forEach((value, key) =>
      beacon.set(key, value)
    );
    if (nuid && !beacon.has("nuid")) {
      beacon.set("nuid", nuid.value);
    }
    if (ua && !beacon.has("ua")) {
      beacon.set("ua", ua.value);
    }
    if (lang && !beacon.has("lang")) {
      const langval = /^[^;,]+/.exec(lang.value);
      beacon.set("lang", langval ? langval[0] : lang.value);
    }
    if (refr && !beacon.has("url")) {
      beacon.set("url", refr.value);
    }

    beacons.push(beacon);
  }

  return [[id, collector, method], beacons];
};

export const Timeline = {
  view: (vnode: Vnode<ITimeline>) => {
    const url = getPageUrl(vnode.attrs.requests);
    return m(
      "div.panel",
      m(
        "p.panel-heading",
        { title: url && url.href },
        url ? url.pathname.slice(0, 34) : "Current Page"
      ),
      Array.prototype.concat.apply(
        [],
        vnode.attrs.requests.map((x, i) => {
          const summary = summariseBeacons(x, i, vnode.attrs.filter);
          return summary.map((y) =>
            m(
              "a.panel-block",
              {
                class: [
                  vnode.attrs.isActive(y) ? "is-active" : "",
                  // Some race in Firefox where the response information isn't always populated
                  x.response.status === 200 || x.response.status === 0
                    ? ""
                    : "not-ok",
                  colourOf(y),
                  y.validity === "Invalid" ? "is-invalid" : "",
                ].join(" "),
                onclick: vnode.attrs.setActive.bind(null, y),
                title: [
                  `Time: ${y.time}`,
                  `Collector: ${y.collector}`,
                  `App ID: ${y.appId}`,
                  `Status: ${x.response.status} ${x.response.statusText}`,
                  `Validity: ${y.validity}`,
                ].join("\n"),
              },
              m("span.panel-icon", "\u26ab\ufe0f"),
              y.eventName,
              m(
                "span.panel-icon.validity",
                y.validity === "Invalid" ? "\u26d4\ufe0f" : ""
              )
            )
          );
        })
      )
    );
  },
};
