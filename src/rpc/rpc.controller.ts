import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { ReqAuth, RequestAuthGuard } from '../auth/request/request-auth.guard';
import { RpcService } from './rpc.service';

/**
 * PostgREST'in `POST /rest/v1/rpc/:name`'inin karşılığı (K6): aynı `p_*`
 * parametre adları, aynı JSON. Supabase istemcisi `apikey` başlığını da
 * gönderir; okunmaz.
 */
@Controller('rpc')
@UseGuards(RequestAuthGuard)
export class RpcController {
  constructor(private readonly rpc: RpcService) {}

  @Post(':name')
  @HttpCode(200)
  async call(
    @Param('name') name: string,
    @Body() body: unknown,
    @ReqAuth() auth: RequestAuth,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.rpc.call(name, body, auth);
    // Nest `null`'ı boş gövdeyle gönderir; PostgREST `null` yazar.
    res.status(200).type('application/json').send(JSON.stringify(result));
  }
}
