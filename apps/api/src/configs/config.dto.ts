import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  ValidateIf,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import type {
  CatalogImage,
  ConfigServiceInput,
  CreateComposeConfigRequest,
  SuppliedEnvironmentValueInput,
  ServiceEnvironmentBindingInput,
} from "@docker-image-creator/contracts";

export class ConfigServiceDto implements ConfigServiceInput {
  @IsString() @Matches(/^[a-z][a-z0-9-]{0,29}$/) name!: string;
  @IsIn(["code", "web-server", "database"]) type!: ConfigServiceInput["type"];
  @IsIn(["node", "python", "mysql", "mongodb"]) image!: CatalogImage;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(["javascript", "python"])
  language?: ConfigServiceInput["language"];
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,31}$/)
  database?: string;
}

export class CreateConfigDto implements CreateComposeConfigRequest {
  @IsIn([2])
  inputVersion!: 2;

  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => EnvironmentValueDto)
  environmentValues!: EnvironmentValueDto[];

  @IsArray()
  @ArrayMaxSize(128)
  @ValidateNested({ each: true })
  @Type(() => EnvironmentBindingDto)
  environmentBindings!: EnvironmentBindingDto[];
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

export class EnvironmentValueDto implements SuppliedEnvironmentValueInput {
  @IsString() @Matches(/^[a-z][a-z0-9_-]{0,63}$/) key!: string;
  @IsString() @Length(1, 4096) value!: string;
  @IsString() @Length(1, 500) purpose!: string;
}

export class EnvironmentBindingDto implements ServiceEnvironmentBindingInput {
  @IsString() @Matches(/^[a-z][a-z0-9-]{0,29}$/) service!: string;
  @IsString() @Matches(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/) name!: string;
  @IsString() @Matches(/^[a-z][a-z0-9_-]{0,63}$/) valueKey!: string;
}
