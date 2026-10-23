import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "manfrod", isDev: process.env.INNGEST_DEV === "1" });

export const EVENTS = {
  jobScheduled: "manfrod/job.scheduled",
  jobCancelled: "manfrod/job.cancelled",
  sessionActivity: "manfrod/session.activity",
  bufferPushed: "manfrod/memory.buffer.pushed",
  proactiveRequested: "manfrod/proactive.requested",
} as const;

export interface JobScheduledData {
  jobId: number;
}

export interface SessionActivityData {
  sessionKey: string;
  writeAccess: string[];
  slackChannelId: string | null;
}

export interface BufferPushedData {
  channelId: string;
  threadKey: string;
}

export const ROOT_THREAD_KEY = "root";

export async function sendEvent(name: string, data: object): Promise<boolean> {
  try {
    await inngest.send({ name, data: data as Record<string, unknown> });
    return true;
  } catch (error) {
    console.warn(`[warning] inngest: failed to send ${name}: ${(error as Error).message}`);
    return false;
  }
}
