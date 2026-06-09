// ════════════════════════════════════════════════════════════
// MARKETPLACE MODULE — Stub (Feature not yet live)
//
// Full implementation is designed and commented out below.
// These stub endpoints return 503 with a clear message so the
// Android client can show a "coming soon" state instead of
// crashing with a network error.
//
// To activate: uncomment the full implementation, run the
// marketplace DB migration, and replace MarketplaceModule
// with the real exports.
// ════════════════════════════════════════════════════════════
import {
  Module, Controller, Get, Post,
  HttpCode, HttpStatus, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards';

const COMING_SOON_MSG = 'Marketplace is coming soon! Stay tuned for updates.';

@ApiTags('Marketplace')
@UseGuards(JwtAuthGuard)
@Controller('marketplace')
class MarketplaceStubController {

  @Get()
  list() {
    // Return empty list with a flag — Android can show "coming soon" UI
    return {
      success: true,
      data: { items: [], meta: { total: 0, page: 1, limit: 30, totalPages: 0, hasNext: false } },
      message: COMING_SOON_MSG,
      comingSoon: true,
    };
  }

  @Get('my-listings')
  myListings() {
    return { success: true, data: { listings: [] }, message: COMING_SOON_MSG, comingSoon: true };
  }

  @Get('my-purchases')
  myPurchases() {
    return { success: true, data: { purchases: [] }, message: COMING_SOON_MSG, comingSoon: true };
  }

  @Get(':id')
  getDetail() {
    throw new ServiceUnavailableException(COMING_SOON_MSG);
  }

  @Get(':id/access')
  getAccess() {
    throw new ServiceUnavailableException(COMING_SOON_MSG);
  }

  @Post(':id/purchase')
  @HttpCode(HttpStatus.SERVICE_UNAVAILABLE)
  purchase() {
    throw new ServiceUnavailableException(COMING_SOON_MSG);
  }
}

@Module({
  controllers: [MarketplaceStubController],
})
export class MarketplaceModule {}
