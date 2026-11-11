import { strict as assert } from "assert";
import { joinMeeting } from "../index";
import { AdmissionError } from "../shared/admission";
import { joinGoogleMeeting, waitForAnySelector } from "./join";
import { checkForWaitingRoomIndicators, waitForGoogleMeetingAdmission } from "./admission";
import { googleJoinButtonSelectors, googleNameInputSelectors } from "./selectors";
import {
  GoogleJoinRefusedError, watchGoogleJoinRefusal, checkForGoogleJoinRefused,
  knockUntilGoogleAccepts, assertGoogleJoinActive,
} from "./refusal";

type Attempt = "before" | "after" | "admit";
function fixture(plan: Attempt[]) {
  const listeners: ((response: any) => void)[] = [];
  let attempts = 0, admitted = false, clicked = false, closed = false;
  const states: string[] = [];
  const response = (call: string, status = 403, host = "meet.google.com") => {
    for (const listener of listeners) listener({
      status: () => status,
      url: () => "https://" + host + "/$rpc/google.rtc.meetings.v1." + call,
    });
  };
  const visible = (selector: string) =>
    (!clicked && (googleNameInputSelectors.includes(selector) || googleJoinButtonSelectors.includes(selector))) ||
    (admitted && selector === '[data-self-name]');
  const handle = (selector: string) => ({
    click: async () => {
      if (googleJoinButtonSelectors.includes(selector)) {
        clicked = true;
        if (plan[attempts - 1] === "after") response("MeetingDeviceService/CreateMeetingDevice");
        else admitted = true;
      }
    },
    isVisible: async () => true,
  });
  const page: any = {
    states, response, attempts: () => attempts,
    on: (event: string, listener: any) => { if (event === "response") listeners.push(listener); },
    isClosed: () => closed,
    close: async () => { closed = true; },
    goto: async () => {
      attempts++; admitted = false; clicked = false;
      if (plan[attempts - 1] === "before") response("MeetingSpaceService/ResolveMeetingSpace");
    },
    bringToFront: async () => {}, screenshot: async () => {},
    waitForTimeout: async () => {}, fill: async () => {}, mouse: { move: async () => {} },
    waitForSelector: async (selector: string) => visible(selector) ? handle(selector) : null,
    locator: (selector: string) => ({
      count: async () => admitted && selector === '[data-self-name]' ? 1 : 0,
      evaluateAll: async () => 0,
      first: () => ({ isVisible: async () => visible(selector), getAttribute: async () => null }),
    }),
    frames: () => [],
  };
  return page;
}

const opts = { meetingUrl: "https://meet.google.com/abc-defg-hij", platform: "google_meet" as const,
  botName: "VOXAI", uiInteractionMode: "synthetic" as const, waitingRoomTimeoutMs: 10000 };
async function main() {
  let checks = 0;
  for (const plan of [["before", "admit"], ["after", "admit"], ["before", "after", "admit"]] as Attempt[][]) {
    const page = fixture(plan);
    const result = await joinMeeting(page, { ...opts, hooks: { onState: state => { page.states.push(state); } } });
    assert.equal(result.admitted, true);
    assert.equal(page.attempts(), plan.length);
    // No refused attempt is reported as a host-admission wait.
    assert.ok(page.states.filter((s: string) => s === "awaiting_admission").length <= 1);
    checks++;
  }
  {
    const page = fixture(["before", "before", "before"]);
    await assert.rejects(joinMeeting(page, opts), (e: any) =>
      e instanceof GoogleJoinRefusedError && e.outcome === "denial" && e.message.includes("3 of 3"));
    assert.equal(page.attempts(), 3);
    checks++;
  }
  {
    let attempts = 0;
    const hostDenial = new AdmissionError("denial", "The host declined");
    await assert.rejects(knockUntilGoogleAccepts({} as any, 10000, async () => {
      attempts++; throw hostDenial;
    }), (error: any) => error === hostDenial);
    assert.equal(attempts, 1);
    checks++;
  }
  {
    let clock = 0;
    const budgets: number[] = [];
    await assert.rejects(knockUntilGoogleAccepts({} as any, 30000, async remaining => {
      budgets.push(remaining); clock += 20000; throw new GoogleJoinRefusedError("ResolveMeetingSpace answered HTTP 403");
    }, () => clock), GoogleJoinRefusedError);
    assert.deepEqual(budgets, [30000, 10000]);
    checks++;
  }
  for (const stop of ["signal", "closed"]) {
    const controller = new AbortController();
    const page = fixture(["before"]);
    let knocks = 0;
    await assert.rejects(knockUntilGoogleAccepts(page, 10000, async () => {
      knocks++;
      if (stop === "signal") controller.abort();
      else await page.close();
      throw new GoogleJoinRefusedError("ResolveMeetingSpace answered HTTP 403");
    }, Date.now, controller.signal), (e: any) => e.name === "AbortError");
    assert.equal(knocks, 1);
    checks++;
  }
  {
    const page = fixture(["admit"]);
    watchGoogleJoinRefusal(page);
    page.response("MeetingSpaceService/ResolveMeetingSpace", 403, "example.invalid");
    page.response("MeetingSpaceService/ResolveMeetingSpace", 404);
    page.response("SomethingElse/Get", 403);
    assert.equal(await checkForGoogleJoinRefused(page), null);
    page.response("MeetingSpaceService/ResolveMeetingSpace");
    await assert.rejects(waitForGoogleMeetingAdmission(page, 10000, {} as any), GoogleJoinRefusedError);
    checks++;
  }
  {
    const page = fixture(["admit"]);
    watchGoogleJoinRefusal(page);
    page.response("MeetingDeviceService/CreateMeetingDevice");
    // The captured network refusal survives a subsequent marketing-page redirect.
    page.locator = (selector: string) => ({ first: () => ({
      isVisible: async () => selector === 'button:has-text("Return to home screen")',
    }) });
    assert.equal(await checkForWaitingRoomIndicators(page), false);
    await assert.rejects(waitForGoogleMeetingAdmission(page, 10000, {} as any), GoogleJoinRefusedError);
    checks++;
  }
  {
    const page = fixture(["before"]);
    await assert.rejects(joinGoogleMeeting(page, opts.meetingUrl, opts.botName, {
      platform: "google_meet", uiInteractionMode: "synthetic",
    }), GoogleJoinRefusedError);
    // Removing the guard from the actual navigation path makes this fail.
    checks++;
  }
  {
    const page = fixture(["admit"]);
    let polls = 0;
    page.locator = () => ({ first: () => ({ isVisible: async () => false }) });
    await assert.rejects(waitForAnySelector(page, ["input"], 120000, "name", async () => {
      if (++polls === 3) throw new GoogleJoinRefusedError("ResolveMeetingSpace answered HTTP 403");
    }), GoogleJoinRefusedError);
    assert.equal(polls, 3);
    checks++;
  }
  {
    const page = fixture(["admit"]);
    await assert.rejects(joinGoogleMeeting(page, opts.meetingUrl, opts.botName, {
      platform: "google_meet", joinDeadline: Date.now() - 1, uiInteractionMode: "synthetic",
    }), (error: any) => error instanceof AdmissionError && error.outcome === "join_failure");
    assert.equal(page.attempts(), 0);
    checks++;
  }
  {
    const page = fixture(["admit"]);
    page.locator = (selector: string) => ({ first: () => ({
      isVisible: async () => selector === 'text=Asking to be let in',
    }) });
    await assert.rejects(waitForGoogleMeetingAdmission(page, 10000, {
      joinDeadline: Date.now() - 1,
    } as any), (error: any) => error instanceof AdmissionError && error.outcome === "lobby_timeout");
    checks++;
  }
  assert.throws(() => assertGoogleJoinActive({} as any, undefined, Date.now() - 1), AdmissionError);
  console.log("refused-join: " + (checks + 1) + " regression scenarios passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
