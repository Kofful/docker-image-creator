export interface HealthResponse {
  status: 'ok';
  service: 'api';
}

export interface CredentialsRequest {
  email: string;
  password: string;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResponse {
  user: AuthUser;
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}
