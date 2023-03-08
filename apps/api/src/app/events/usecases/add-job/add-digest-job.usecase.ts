import { Injectable } from '@nestjs/common';
import { JobEntity, JobRepository, JobStatusEnum } from '@novu/dal';
import { DigestUnitEnum, ExecutionDetailsSourceEnum, ExecutionDetailsStatusEnum, StepTypeEnum } from '@novu/shared';

import { AddDigestJobCommand } from './add-digest-job.command';
import { AddJob } from './add-job.usecase';
import { DigestFilterSteps } from '../digest-filter-steps/digest-filter-steps.usecase';

import {
  CreateExecutionDetails,
  CreateExecutionDetailsCommand,
} from '../../../execution-details/usecases/create-execution-details';
import { DetailEnum } from '../../../execution-details/types';
import { ApiException } from '../../../shared/exceptions/api.exception';
import { EventsDistributedLockService } from '../../services/distributed-lock-service';

interface IFindAndUpdateResponse {
  matched: number;
  modified: number;
}

type AddDigestJobResult = number | undefined;

@Injectable()
export class AddDigestJob {
  constructor(
    private distributedLockService: EventsDistributedLockService,
    private jobRepository: JobRepository,
    protected createExecutionDetails: CreateExecutionDetails
  ) {}

  public async execute(command: AddDigestJobCommand): Promise<AddDigestJobResult> {
    const { job } = command;

    this.validateDigest(job);

    return await this.shouldDelayDigestOrMerge(job);
  }

  private validateDigest(job: JobEntity): void {
    if (job.type !== StepTypeEnum.DIGEST) {
      throw new ApiException('Job is not a digest type');
    }

    if (!job.digest?.amount) {
      throw new ApiException('Invalid digest amount');
    }

    if (!job.digest?.unit) {
      throw new ApiException('Invalid digest unit');
    }
  }

  private async shouldDelayDigestOrMerge(job: JobEntity): Promise<AddDigestJobResult> {
    const digestKey = job.step.metadata?.digestKey;
    const digestValue = DigestFilterSteps.getNestedValue(job.payload, job.step.metadata?.digestKey);

    const { matched, modified } = await this.shouldDelayDigestOrMergeWithLock(job, digestKey, digestValue);

    // We merged the digest job as there was an existing delayed digest job for this subscriber and template in the same time frame
    if (matched > 0 && modified === 0) {
      await this.digestMergedExecutionDetails(job);

      return undefined;
    }

    // We delayed the job and created the digest
    if (matched === 0 && modified === 1) {
      const { digest } = job;

      if (!digest?.amount || !digest?.unit) {
        throw new ApiException(`Somehow ${job._id} had wrong digest settings and escaped validation`);
      }

      return AddJob.toMilliseconds(digest.amount, digest.unit);
    }

    return undefined;
  }

  private async shouldDelayDigestOrMergeWithLock(
    job: JobEntity,
    digestKey?: string,
    digestValue?: string | number
  ): Promise<IFindAndUpdateResponse> {
    const TTL = 500;
    let resource = `environment:${job._environmentId}:template:${job._templateId}:subscriber:${job._subscriberId}`;
    if (digestKey && digestValue) {
      resource = `${resource}:digestKey:${digestKey}:digestValue:${digestValue}`;
    }

    const shouldDelayDigestJobOrMerge = async () =>
      this.jobRepository.shouldDelayDigestJobOrMerge(job, digestKey, digestValue);

    const result = await this.distributedLockService.applyLock<IFindAndUpdateResponse>(
      {
        resource,
        ttl: TTL,
      },
      shouldDelayDigestJobOrMerge
    );

    return result;
  }

  private async digestMergedExecutionDetails(job: JobEntity): Promise<void> {
    await this.createExecutionDetails.execute(
      CreateExecutionDetailsCommand.create({
        ...CreateExecutionDetailsCommand.getDetailsFromJob(job),
        detail: DetailEnum.DIGEST_MERGED,
        source: ExecutionDetailsSourceEnum.INTERNAL,
        status: ExecutionDetailsStatusEnum.SUCCESS,
        isTest: false,
        isRetry: false,
      })
    );
  }
}
