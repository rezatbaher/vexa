import assert from "node:assert/strict";
import { createBrowserJoinDriver } from "./join-driver.js";

function pageWithRefusals() {
  const listeners: ((r: any) => void)[] = [];
  let count = 0;
  const page: any = {
    on: (event: string, listener: any) => { if (event === "response") listeners.push(listener); },
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    isClosed: () => false,
    evaluate: async () => false,
    close: async () => {},
    count: () => count,
    goto: async () => {
      count++;
      for (const listener of listeners) listener({
        status: () => 403,
        url: () => "https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/ResolveMeetingSpace",
      });
    },
  };
  return page;
}
const invocation: any = {
  platform: "google_meet", meetingUrl: "https://meet.google.com/abc-defg-hij",
  botName: "VOXAI", automaticLeave: { waitingRoomTimeout: 10000 },
};

async function main() {
  {
    const page = pageWithRefusals();
    const driver = createBrowserJoinDriver(page, invocation);
    const states: string[] = [];
    assert.equal(await driver.join(async state => { states.push(state); }), "rejected");
    assert.equal(page.count(), 3);
    assert.ok(driver.failureReason?.()?.startsWith("google_meet_join_refused:"));
    assert.deepEqual(states, []);
  }
  {
    const page = pageWithRefusals();
    const driver = createBrowserJoinDriver(page, invocation);
    const goto = page.goto;
    let releaseClose!: () => void;
    const closed = new Promise<void>(resolve => { releaseClose = resolve; });
    page.close = () => closed;
    let withdrawal: Promise<void> | undefined;
    page.goto = async () => {
      await goto();
      withdrawal = driver.withdraw("stopped");
    };
    try {
      await assert.rejects(driver.join(async () => {}), (error: any) => error.name === "AbortError");
      assert.equal(page.count(), 1, "withdraw aborts retries before the browser finishes closing");
    } finally {
      releaseClose();
      await withdrawal;
    }
  }
  console.log("join-driver refusal: 2 entrypoint scenarios passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
