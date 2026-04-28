import {
  Injectable, CanActivate, ExecutionContext,
  UnauthorizedException, ForbiddenException, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

// ── Decorators ────────────────────────────────────────────────
export const ROLES_KEY      = 'roles';
export const IS_PUBLIC_KEY  = 'isPublic';
export const PERMISSION_KEY = 'permission';

export const Roles             = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
export const Public            = ()                   => SetMetadata(IS_PUBLIC_KEY, true);
export const RequirePermission = (p: string)          => SetMetadata(PERMISSION_KEY, p);

// ── JWT Auth Guard (Global — for mobile users only) ───────────
//
// IMPORTANT: Admin routes (/admin/*) are intentionally EXCLUDED
// from this global guard. They use AdminJwtGuard on each controller
// with a different secret (ADMIN_JWT_SECRET).
//
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const req  = context.switchToHttp().getRequest();
    const path: string = req.path || req.url || '';

    // Skip for ALL /admin/ routes — protected by AdminJwtGuard
    if (path.includes('/admin/') || path.endsWith('/admin')) {
      return true;
    }

    // Skip for routes marked @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      if (info?.name === 'TokenExpiredError') {
        throw new UnauthorizedException({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      throw new UnauthorizedException('Invalid or missing token');
    }
    if (user.status === 'banned') {
      throw new ForbiddenException('Your account has been suspended. Contact support.');
    }
    return user;
  }
}

// ── Admin JWT Guard (per admin controller) ────────────────────
@Injectable()
export class AdminJwtGuard extends AuthGuard('admin-jwt') {
  handleRequest(err: any, admin: any, info: any) {
    if (err || !admin) {
      if (info?.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Admin session expired. Please login again.');
      }
      throw new UnauthorizedException('Admin authentication required');
    }
    if (admin.status !== 'active') {
      throw new ForbiddenException('Admin account is inactive');
    }
    return admin;
  }
}

// ── Permission Guard ──────────────────────────────────────────
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) return true;

    const request = context.switchToHttp().getRequest();
    const admin   = request.admin;
    if (!admin) throw new UnauthorizedException();

    const perms: string[] = admin.permissions || [];
    if (perms.includes('all') || perms.includes(permission)) return true;

    throw new ForbiddenException(`Permission required: ${permission}`);
  }
}

// ── Subscription Guard ────────────────────────────────────────
@Injectable()
export class SubscriptionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!request.user?.isSubscribed) {
      throw new ForbiddenException({
        message: 'Active subscription required',
        code: 'SUBSCRIPTION_REQUIRED',
      });
    }
    return true;
  }
}
