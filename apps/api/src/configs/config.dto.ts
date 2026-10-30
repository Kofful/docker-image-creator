import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  ValidateIf,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import type {
  CatalogImage,
  ConfigServiceInput,
  CreateConfigRequest,
} from "@docker-image-creator/contracts";

export class ConfigServiceDto implements ConfigServiceInput {
  @IsString() @Matches(/^[a-z][a-z0-9-]{0,29}$/) name!: string;
  @IsIn(["code", "web-server", "database"]) type!: ConfigServiceInput["type"];
  @IsIn(["node", "python", "mysql", "mongodb"]) image!: CatalogImage;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(["javascript", "python"])
  language?: ConfigServiceInput["language"];
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1024)
  @Max(65535)
  hostPort?: number;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,31}$/)
  database?: string;
}

export class CreateConfigDto implements CreateConfigRequest {
  @IsString() @Length(1, 80) @Matches(/\S/) name!: string;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(500)
  description?: string;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(16000)
  instructions?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ConfigServiceDto)
  services!: ConfigServiceDto[];
}
