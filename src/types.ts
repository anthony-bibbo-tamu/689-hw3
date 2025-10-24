export type ServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type AppConfig = {
  servers: ServerConfig[];
};
