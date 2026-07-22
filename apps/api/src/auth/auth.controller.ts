import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './auth.decorators';
import { AuthUser } from '../common/constants';

class LoginDto {
  @IsString() @MaxLength(50) username: string;
  @IsString() @MinLength(6) @MaxLength(100) password: string;
}

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}
  @Public() @Post('login') login(@Body() dto: LoginDto) { return this.service.login(dto.username, dto.password); }
  @Get('me') me(@CurrentUser() user: AuthUser) { return user; }
}
