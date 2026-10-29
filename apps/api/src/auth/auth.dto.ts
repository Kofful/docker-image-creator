import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { CredentialsRequest, RefreshTokenRequest } from '@docker-image-creator/contracts';

export class CredentialsDto implements CredentialsRequest {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({ allow_utf8_local_part: false })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(12, 128)
  password!: string;
}

export class RefreshTokenDto implements RefreshTokenRequest {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  refresh_token!: string;
}
