import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';

const rootPackage = require('../../../../package.json');

@Controller('system')
export class SystemController{
  @Public() @Get('version') version(){
    return {
      version:process.env.APP_VERSION||rootPackage.version,
      buildTime:process.env.BUILD_TIME||null,
      gitCommit:process.env.GIT_COMMIT||'development',
      environment:process.env.APP_ENV||process.env.NODE_ENV||'development',
    };
  }
}
