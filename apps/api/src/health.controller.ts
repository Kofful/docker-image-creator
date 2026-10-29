import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@docker-image-creator/contracts';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { status: 'ok', service: 'api' };
  }
}
