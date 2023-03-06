import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Novu } from '@novu/node';
import { UserRepository, UserEntity, IUserResetTokenCount } from '@novu/dal';
import { v4 as uuidv4 } from 'uuid';
import { differenceInHours, differenceInSeconds, parseISO } from 'date-fns';
import { normalizeEmail } from '../../../shared/helpers/email-normalization.service';
import { PasswordResetRequestCommand } from './password-reset-request.command';
import { CacheKeyPrefixEnum, InvalidateCacheService } from '../../../shared/services/cache';

@Injectable()
export class PasswordResetRequest {
  private MAX_ATTEMPTS_IN_A_MINUTE = 5;
  private MAX_ATTEMPTS_IN_A_DAY = 15;
  private RATE_LIMIT_IN_SECONDS = 60;
  private RATE_LIMIT_IN_HOURS = 24;
  constructor(private invalidateCache: InvalidateCacheService, private userRepository: UserRepository) {}

  async execute(command: PasswordResetRequestCommand): Promise<{ success: boolean }> {
    const email = normalizeEmail(command.email);
    const foundUser = await this.userRepository.findByEmail(email);
    if (foundUser && foundUser.email) {
      const { error, isBlocked } = this.isRequestBlocked(foundUser);
      if (isBlocked) {
        throw new UnauthorizedException(error);
      }
      const token = uuidv4();

      this.invalidateCache.clearCache({
        storeKeyPrefix: [CacheKeyPrefixEnum.USER],
        credentials: {
          _id: foundUser._id,
        },
      });

      const resetTokenCount = this.getUpdatedRequestCount(foundUser);
      await this.userRepository.updatePasswordResetToken(foundUser._id, token, resetTokenCount);

      if ((process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'prod') && process.env.NOVU_API_KEY) {
        const novu = new Novu(process.env.NOVU_API_KEY);

        novu.trigger(process.env.NOVU_TEMPLATEID_PASSWORD_RESET || 'password-reset-llS-wzWMq', {
          to: {
            subscriberId: foundUser._id,
            email: foundUser.email,
          },
          payload: {
            resetPasswordLink: `${process.env.FRONT_BASE_URL}/auth/reset/${token}`,
          },
        });
      }
    }

    return {
      success: true,
    };
  }

  private isRequestBlocked(user: UserEntity) {
    const lastResetAttempt = user.resetTokenDate;

    if (!lastResetAttempt) {
      return {
        isBlocked: false,
        error: '',
      };
    }
    const formattedDate = parseISO(lastResetAttempt);
    const diffSeconds = differenceInSeconds(new Date(), formattedDate);
    const diffHours = differenceInHours(new Date(), formattedDate);

    const withinDailyLimit = diffHours < this.RATE_LIMIT_IN_HOURS;
    const exceededDailyAttempt = user?.resetTokenCount
      ? user?.resetTokenCount?.reqInDay >= this.MAX_ATTEMPTS_IN_A_DAY
      : false;
    if (withinDailyLimit && exceededDailyAttempt) {
      return {
        isBlocked: true,
        error: `Too many requests, Try again after ${this.RATE_LIMIT_IN_HOURS} hours.`,
      };
    }

    const withinMinuteLimit = diffSeconds < this.RATE_LIMIT_IN_SECONDS;
    const exceededMinuteAttempt = user?.resetTokenCount
      ? user?.resetTokenCount?.reqInMinute >= this.MAX_ATTEMPTS_IN_A_MINUTE
      : false;
    if (withinMinuteLimit && exceededMinuteAttempt) {
      return {
        isBlocked: true,
        error: `Too many requests, Try again after a minute.`,
      };
    }

    return {
      isBlocked: false,
      error: '',
    };
  }

  private getUpdatedRequestCount(user: UserEntity): IUserResetTokenCount {
    const now = new Date().toISOString();
    const lastResetAttempt = user.resetTokenDate ?? now;
    const formattedDate = parseISO(lastResetAttempt);
    const diffSeconds = differenceInSeconds(new Date(), formattedDate);
    const diffHours = differenceInHours(new Date(), formattedDate);

    const resetTokenCount: IUserResetTokenCount = {
      reqInMinute: user.resetTokenCount?.reqInMinute ?? 0,
      reqInDay: user.resetTokenCount?.reqInDay ?? 0,
    };

    resetTokenCount.reqInMinute = diffSeconds < this.RATE_LIMIT_IN_SECONDS ? resetTokenCount.reqInMinute + 1 : 1;
    resetTokenCount.reqInDay = diffHours < this.RATE_LIMIT_IN_HOURS ? resetTokenCount.reqInDay + 1 : 1;

    return resetTokenCount;
  }
}
