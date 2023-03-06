import { forwardRef, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  EnvironmentRepository,
  MemberEntity,
  MemberRepository,
  OrganizationRepository,
  SubscriberEntity,
  SubscriberRepository,
  UserEntity,
  UserRepository,
} from '@novu/dal';
import { AuthProviderEnum, IJwtPayload, ISubscriberJwt, MemberRoleEnum, SignUpOriginEnum } from '@novu/shared';
import { AnalyticsService } from '@novu/application-generic';

import { CreateUserCommand } from '../../user/usecases/create-user/create-user.dto';
import { CreateUser } from '../../user/usecases/create-user/create-user.usecase';
import { SwitchEnvironmentCommand } from '../usecases/switch-environment/switch-environment.command';
import { SwitchEnvironment } from '../usecases/switch-environment/switch-environment.usecase';
import { SwitchOrganization } from '../usecases/switch-organization/switch-organization.usecase';
import { SwitchOrganizationCommand } from '../usecases/switch-organization/switch-organization.command';
import { ANALYTICS_SERVICE } from '../../shared/shared.module';
import { CacheKeyPrefixEnum } from '../../shared/services/cache';
import { Cached } from '../../shared/interceptors';
import { normalizeEmail } from '../../shared/helpers/email-normalization.service';
import { ApiException } from '../../shared/exceptions/api.exception';

@Injectable()
export class AuthService {
  constructor(
    private userRepository: UserRepository,
    private subscriberRepository: SubscriberRepository,
    private createUserUsecase: CreateUser,
    private jwtService: JwtService,
    @Inject(ANALYTICS_SERVICE) private analyticsService: AnalyticsService,
    private organizationRepository: OrganizationRepository,
    private environmentRepository: EnvironmentRepository,
    private memberRepository: MemberRepository,
    @Inject(forwardRef(() => SwitchOrganization)) private switchOrganizationUsecase: SwitchOrganization,
    @Inject(forwardRef(() => SwitchEnvironment)) private switchEnvironmentUsecase: SwitchEnvironment
  ) {}

  async authenticate(
    authProvider: AuthProviderEnum,
    accessToken: string,
    refreshToken: string,
    profile: { name: string; login: string; email: string; avatar_url: string; id: string },
    distinctId: string,
    origin?: SignUpOriginEnum
  ) {
    const email = normalizeEmail(profile.email);
    let user = await this.userRepository.findByEmail(email);
    let newUser = false;

    if (!user) {
      user = await this.createUserUsecase.execute(
        CreateUserCommand.create({
          picture: profile.avatar_url,
          email,
          lastName: profile.name ? profile.name.split(' ').slice(-1).join(' ') : null,
          firstName: profile.name ? profile.name.split(' ').slice(0, -1).join(' ') : profile.login,
          auth: {
            username: profile.login,
            profileId: profile.id,
            provider: authProvider,
            accessToken,
            refreshToken,
          },
        })
      );
      newUser = true;

      if (distinctId) {
        this.analyticsService.alias(distinctId, user._id);
      }

      this.analyticsService.track('[Authentication] - Signup', user._id, {
        loginType: authProvider,
        origin: origin,
      });
    } else {
      if (authProvider === AuthProviderEnum.GITHUB) {
        const withoutUsername = user.tokens.find(
          (i) => i.provider === AuthProviderEnum.GITHUB && !i.username && String(i.providerId) === String(profile.id)
        );

        if (withoutUsername) {
          await this.userRepository.update(
            {
              _id: user._id,
              'tokens.providerId': profile.id,
            },
            {
              $set: {
                'tokens.$.username': profile.login,
              },
            }
          );

          user = await this.userRepository.findById(user._id);
          if (!user) throw new ApiException('User not found');
        }
      }

      this.analyticsService.track('[Authentication] - Login', user._id, {
        loginType: authProvider,
      });
    }

    this.analyticsService.upsertUser(user, user._id);

    return {
      newUser,
      token: await this.generateUserToken(user),
    };
  }

  async refreshToken(userId: string) {
    const user = await this.getUser({ _id: userId });
    if (!user) throw new UnauthorizedException('User not found');

    return this.getSignedToken(user);
  }

  async isAuthenticatedForOrganization(userId: string, organizationId: string): Promise<boolean> {
    return !!(await this.memberRepository.isMemberOfOrganization(organizationId, userId));
  }

  async apiKeyAuthenticate(apiKey: string) {
    const environment = await this.getEnvironment({ _id: apiKey });
    if (!environment) throw new UnauthorizedException('API Key not found');

    const key = environment.apiKeys.find((i) => i.key === apiKey);
    if (!key) throw new UnauthorizedException('API Key not found');

    const user = await this.getUser({ _id: key._userId });
    if (!user) throw new UnauthorizedException('User not found');

    return await this.getApiSignedToken(user, environment._organizationId, environment._id, key.key);
  }

  async getSubscriberWidgetToken(subscriber: SubscriberEntity, userId: string): Promise<string> {
    return this.jwtService.sign(
      {
        _id: subscriber._id,
        firstName: subscriber.firstName,
        lastName: subscriber.lastName,
        email: subscriber.email,
        organizationId: subscriber._organizationId,
        environmentId: subscriber._environmentId,
        subscriberId: subscriber.subscriberId,
        organizationAdminId: userId,
      },
      {
        expiresIn: '15 day',
        issuer: 'novu_api',
        audience: 'widget_user',
      }
    );
  }

  async getApiSignedToken(
    user: UserEntity,
    organizationId: string,
    environmentId: string,
    apiKey: string
  ): Promise<string> {
    return this.jwtService.sign(
      {
        _id: user._id,
        firstName: 'API Request',
        lastName: null,
        email: user.email,
        profilePicture: null,
        organizationId,
        roles: [MemberRoleEnum.ADMIN],
        apiKey,
        environmentId,
      },
      {
        expiresIn: '1 day',
        issuer: 'novu_api',
        audience: 'api_token',
      }
    );
  }

  async generateUserToken(user: UserEntity) {
    const userActiveOrganizations = await this.organizationRepository.findUserActiveOrganizations(user._id);

    if (userActiveOrganizations && userActiveOrganizations.length) {
      const organizationToSwitch = userActiveOrganizations[0];

      const userActiveProjects = await this.environmentRepository.findOrganizationEnvironments(
        organizationToSwitch._id
      );
      let environmentToSwitch = userActiveProjects[0];

      const reduceEnvsToOnlyDevelopment = (prev, current) => (current.name === 'Development' ? current : prev);

      if (userActiveProjects.length > 1) {
        environmentToSwitch = userActiveProjects.reduce(reduceEnvsToOnlyDevelopment, environmentToSwitch);
      }

      if (environmentToSwitch) {
        return await this.switchEnvironmentUsecase.execute(
          SwitchEnvironmentCommand.create({
            newEnvironmentId: environmentToSwitch._id,
            organizationId: organizationToSwitch._id,
            userId: user._id,
          })
        );
      }

      return await this.switchOrganizationUsecase.execute(
        SwitchOrganizationCommand.create({
          newOrganizationId: organizationToSwitch._id,
          userId: user._id,
        })
      );
    }

    return this.getSignedToken(user);
  }

  async getSignedToken(
    user: UserEntity,
    organizationId?: string,
    member?: MemberEntity,
    environmentId?: string
  ): Promise<string> {
    const roles: MemberRoleEnum[] = [];
    if (member && member.roles) {
      roles.push(...member.roles);
    }

    return this.jwtService.sign(
      {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePicture: user.profilePicture,
        organizationId: organizationId || null,
        roles,
        environmentId: environmentId || null,
      },
      {
        expiresIn: '30 days',
        issuer: 'novu_api',
      }
    );
  }

  async validateUser(payload: IJwtPayload): Promise<UserEntity> {
    const user = await this.getUser({ _id: payload._id });
    if (!user) throw new UnauthorizedException('User not found');

    if (payload.organizationId) {
      const isMember = await this.isAuthenticatedForOrganization(payload._id, payload.organizationId);
      if (!isMember) throw new UnauthorizedException(`No authorized for organization ${payload.organizationId}`);
    }

    return user;
  }

  async validateSubscriber(payload: ISubscriberJwt): Promise<SubscriberEntity | null> {
    const subscriber = await this.getSubscriber({
      environmentId: payload.environmentId,
      _id: payload._id,
    });

    return subscriber;
  }

  async decodeJwt<T>(token: string) {
    return this.jwtService.decode(token) as T;
  }

  async verifyJwt(jwt: string) {
    return this.jwtService.verify(jwt);
  }

  async isRootEnvironment(payload: IJwtPayload): Promise<boolean> {
    const environment = await this.environmentRepository.findOne({
      _id: payload.environmentId,
    });
    if (!environment) throw new NotFoundException('Environment not found');

    return !!environment._parentId;
  }

  @Cached(CacheKeyPrefixEnum.SUBSCRIBER)
  private async getSubscriber({ _id, environmentId }: { _id: string; environmentId: string }) {
    const subscriber = await this.subscriberRepository.findOne({
      _environmentId: environmentId,
      _id: _id,
    });

    return subscriber;
  }

  @Cached(CacheKeyPrefixEnum.USER)
  private async getUser({ _id }: { _id: string }) {
    return await this.userRepository.findById(_id);
  }

  @Cached(CacheKeyPrefixEnum.ENVIRONMENT_BY_API_KEY)
  private async getEnvironment({ _id }: { _id: string }) {
    /**
     * _id is used here because the Cached decorator needs and it.
     * TODO: Refactor cached decorator to support custom keys
     */
    return await this.environmentRepository.findByApiKey(_id);
  }
}
