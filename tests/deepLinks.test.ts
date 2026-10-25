import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { routeForUrl } from "../src/client/lib/deepLinks.ts";

/*
  Universal links hand the app a full URL. Only the three link shapes the site
  actually produces become routes; anything else is ignored rather than routed
  somewhere the app does not expect.
*/
describe("routeForUrl", () => {
  const base = "https://football-iq.example.dev";

  it("routes a room invite, a challenge and the daily challenge", () => {
    assert.equal(routeForUrl(`${base}/room/482731`), "/room/482731");
    assert.equal(routeForUrl(`${base}/challenge/Ab3kZ9qR`), "/challenge/Ab3kZ9qR");
    assert.equal(routeForUrl(`${base}/daily`), "/daily");
    assert.equal(routeForUrl(`${base}/room/482731/`), "/room/482731");
  });

  it("ignores every other path and anything that is not a URL", () => {
    assert.equal(routeForUrl(`${base}/room/12`), null);
    assert.equal(routeForUrl(`${base}/room/482731/display`), null);
    assert.equal(routeForUrl(`${base}/api/me`), null);
    assert.equal(routeForUrl("not a url"), null);
  });
});
