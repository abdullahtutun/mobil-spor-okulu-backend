import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtVerifier, type RequestAuth } from './jwt-verifier.service';

type AuthedRequest = Request & { auth?: RequestAuth };

/**
 * İsteğin rolünü token'dan çözer ve `request.auth`'a koyar. Hiçbir isteği
 * rol yüzünden geri çevirmez (anon da geçer); geçersiz ya da süresi geçmiş
 * token 401 olur. Ne yapılabileceğine RPC allow-list'i ve veritabanı
 * (GRANT + RLS) karar verir.
 *
 * Global değil, uç başına (`@UseGuards(RequestAuthGuard)`): `/health` ve
 * S05'in `/auth/*` uçları süresi geçmiş bir token'la da çağrılabilmeli.
 */
@Injectable()
export class RequestAuthGuard implements CanActivate {
  constructor(private readonly verifier: JwtVerifier) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    request.auth = this.verifier.fromAuthorizationHeader(
      request.headers.authorization,
    );
    return true;
  }
}

/** `RequestAuthGuard`'ın çözdüğü rol ve claim'ler. */
export const ReqAuth = createParamDecorator(
  (_: unknown, context: ExecutionContext): RequestAuth => {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!request.auth) {
      throw new Error('ReqAuth, RequestAuthGuard olmadan kullanıldı.');
    }
    return request.auth;
  },
);
