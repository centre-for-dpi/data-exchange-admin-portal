import { Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { OPENAPI_OPERATION, type OperationSpec } from './api-operation.decorator.js';
import { buildOpenApiDocument, type RouteDoc } from './openapi.document.js';

export interface DiscoveredRoute {
  method: string;
  path: string;
  handler: string;
  spec?: OperationSpec;
}

const joinPath = (...parts: string[]): string =>
  `/${parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/')}`;

const asList = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [''];
};

@Injectable()
export class OpenApiService {
  private prefix = '';

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  setGlobalPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  /** Every HTTP route declared by controllers, with its OpenAPI spec when documented. */
  routes(): DiscoveredRoute[] {
    const routes: DiscoveredRoute[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance: unknown = wrapper.instance;
      const metatype = wrapper.metatype;
      if (!instance || !metatype) continue;
      const controllerPaths = asList(this.reflector.get(PATH_METADATA, metatype));
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name] as (
          ...args: unknown[]
        ) => unknown;
        const methodPath = this.reflector.get<string | string[] | undefined>(
          PATH_METADATA,
          handler,
        );
        if (methodPath === undefined) continue;
        const method = RequestMethod[this.reflector.get<RequestMethod>(METHOD_METADATA, handler)];
        const spec = this.reflector.get<OperationSpec | undefined>(OPENAPI_OPERATION, handler);
        for (const base of controllerPaths) {
          for (const path of asList(methodPath)) {
            routes.push({
              method,
              path: joinPath(this.prefix, base, path),
              handler: `${metatype.name}.${name}`,
              spec,
            });
          }
        }
      }
    }
    return routes;
  }

  document(info: { title: string; version: string }) {
    const documented = this.routes().filter((r): r is RouteDoc & DiscoveredRoute => !!r.spec);
    return buildOpenApiDocument(documented, info);
  }
}
