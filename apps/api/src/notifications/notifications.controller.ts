import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() list(@Query() q:any,@CurrentUser() u:AuthUser){ return this.service.list(u.id,q); }
  @Get('unread-count') unreadCount(@CurrentUser() u:AuthUser){ return this.service.unreadCount(u.id); }
  @Post(':id/read') read(@Param('id') id:string,@CurrentUser() u:AuthUser){ return this.service.read(id,u.id); }
  @Post('read-all') readAll(@CurrentUser() u:AuthUser){ return this.service.readAll(u.id); }
}
