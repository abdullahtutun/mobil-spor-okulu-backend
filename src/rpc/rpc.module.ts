import { Module } from '@nestjs/common';
import { RpcCatalog } from './rpc-catalog.service';
import { RpcController } from './rpc.controller';
import { RpcService } from './rpc.service';

@Module({
  controllers: [RpcController],
  providers: [RpcCatalog, RpcService],
  exports: [RpcService],
})
export class RpcModule {}
