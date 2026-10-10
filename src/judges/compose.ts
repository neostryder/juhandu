import { NoEndpointError } from "../models/pool.ts";
import { JudgeError } from "./judge.ts";
import type { Judge, JudgeContext, PickQuestion, PickVerdict, RankVerdict, YesNoQuestion, YesNoVerdict } from "./judge.ts";

/** Tries the judges in order and uses the first that answers. A judge that is down, forbidden the data or returns an unusable answer is skipped; if none answers, the failure is a JudgeError when any judge reached a bad answer, else a NoEndpointError so the work queues. */
export class ChainJudge implements Judge {
  private readonly judges: Judge[];

  constructor(judges: Judge[]) {
    if (!judges.length) throw new Error("A judge chain needs at least one judge");
    this.judges = judges;
  }

  private async first<T>(ask: (judge: Judge) => Promise<T>): Promise<T> {
    let unusable: JudgeError | null = null;
    let unavailable: NoEndpointError | null = null;
    for (const judge of this.judges) {
      try {
        return await ask(judge);
      } catch (error) {
        if (error instanceof JudgeError) unusable = error;
        else if (error instanceof NoEndpointError) unavailable ??= error;
        else throw error;
      }
    }
    throw unusable ?? unavailable ?? new NoEndpointError("No judge is available");
  }

  yesNo(q: YesNoQuestion, context: JudgeContext): Promise<YesNoVerdict> {
    return this.first((judge) => judge.yesNo(q, context));
  }

  pickOne(q: PickQuestion, context: JudgeContext): Promise<PickVerdict> {
    return this.first((judge) => judge.pickOne(q, context));
  }

  rank(q: PickQuestion, context: JudgeContext): Promise<RankVerdict> {
    return this.first((judge) => judge.rank(q, context));
  }
}

/** Answers with the primary judge and asks the others the same question only so their answers are logged beside it. A shadow never changes the answer, never delays a failure and never raises one. */
export class ShadowJudge implements Judge {
  private readonly primary: Judge;
  private readonly shadows: Judge[];

  constructor(primary: Judge, shadows: Judge[]) {
    this.primary = primary;
    this.shadows = shadows;
  }

  private async withShadows<T>(result: T, ask: (judge: Judge) => Promise<unknown>): Promise<T> {
    await Promise.allSettled(this.shadows.map((judge) => ask(judge)));
    return result;
  }

  async yesNo(q: YesNoQuestion, context: JudgeContext): Promise<YesNoVerdict> {
    return this.withShadows(await this.primary.yesNo(q, context), (judge) => judge.yesNo(q, context));
  }

  async pickOne(q: PickQuestion, context: JudgeContext): Promise<PickVerdict> {
    return this.withShadows(await this.primary.pickOne(q, context), (judge) => judge.pickOne(q, context));
  }

  async rank(q: PickQuestion, context: JudgeContext): Promise<RankVerdict> {
    return this.withShadows(await this.primary.rank(q, context), (judge) => judge.rank(q, context));
  }
}
