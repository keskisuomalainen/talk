import DataLoader from "dataloader";
import { Redis } from "ioredis";
import { Db } from "mongodb";
import uuid from "uuid";

import { EventEmitter } from "events";
import { Config } from "talk-common/config";
import logger from "talk-server/logger";
import {
  countTenants,
  retrieveAllTenants,
  retrieveManyTenants,
  retrieveManyTenantsByDomain,
  Tenant,
} from "talk-server/models/tenant";

const TENANT_UPDATE_CHANNEL = "tenant";

const EMITTER_EVENT_NAME = "update";

export type SubscribeCallback = (tenant: Tenant) => void;

interface TenantUpdateMessage {
  tenant: Tenant;
  clientApplicationID: string;
}

// TenantCache provides an interface for retrieving tenant stored in local
// memory rather than grabbing it from the database every single call.
export default class TenantCache {
  /**
   * tenantsByID reference the tenants that have been cached/retrieved by ID.
   */
  private tenantsByID: DataLoader<string, Readonly<Tenant> | null>;

  /**
   * tenantsByDomain reference the tenants that have been cached/retrieved by
   * Domain.
   */
  private tenantsByDomain: DataLoader<string, Readonly<Tenant> | null>;

  /**
   * tenantCountCache stores all the id's of all the Tenant's that have crossed
   * it.
   */
  private tenantCountCache = new Set<string>();

  /**
   * primed is true when the cache has already been fully primed.
   */
  private primed: boolean = false;

  /**
   * Create a new client application ID. This prevents duplicated messages
   * generated by this application from being handled as external messages
   * as we should have already processed it.
   */
  private clientApplicationID = uuid.v4();

  private mongo: Db;
  private emitter = new EventEmitter();

  /**
   * cachingEnabled is true when tenant caching has been enabled.
   */
  public cachingEnabled: boolean;

  constructor(mongo: Db, subscriber: Redis, config: Config) {
    this.cachingEnabled = !config.get("disable_tenant_caching");
    if (!this.cachingEnabled) {
      logger.warn("tenant caching is disabled");
    } else {
      logger.debug("tenant caching is enabled");
    }

    // Save the Db reference.
    this.mongo = mongo;

    // Configure the data loaders.
    this.tenantsByID = new DataLoader(
      async ids => {
        logger.debug({ ids: ids.length }, "now loading tenants");
        const tenants = await retrieveManyTenants(this.mongo, ids);
        logger.debug(
          { tenants: tenants.filter(t => t !== null).length },
          "loaded tenants"
        );

        tenants
          .filter(t => t !== null)
          .forEach((t: Readonly<Tenant>) => this.tenantCountCache.add(t.id));

        return tenants;
      },
      {
        cache: this.cachingEnabled,
      }
    );

    this.tenantsByDomain = new DataLoader(
      async domains => {
        logger.debug({ domains: domains.length }, "now loading tenants");
        const tenants = await retrieveManyTenantsByDomain(this.mongo, domains);
        logger.debug(
          { tenants: tenants.filter(t => t !== null).length },
          "loaded tenants"
        );

        tenants
          .filter(t => t !== null)
          .forEach((t: Readonly<Tenant>) => this.tenantCountCache.add(t.id));

        return tenants;
      },
      {
        cache: this.cachingEnabled,
      }
    );

    // We don't need updates if we aren't synced to tenant updates.
    if (this.cachingEnabled) {
      // Attach to messages on this connection so we can receive updates when
      // the tenant are changed.
      subscriber.on("message", this.onMessage);

      // Subscribe to tenant notifications.
      subscriber.subscribe(TENANT_UPDATE_CHANNEL);
    }
  }

  /**
   * count will return the number of Tenant's.
   */
  public async count(): Promise<number> {
    if (!this.cachingEnabled) {
      return countTenants(this.mongo);
    }

    if (!this.primed) {
      await this.primeAll();
    }

    return this.tenantCountCache.size;
  }

  /**
   * primeAll will load all the tenants into the cache on startup.
   */
  public async primeAll() {
    if (!this.cachingEnabled) {
      logger.debug("tenants not primed, caching disabled");
      return;
    }

    // Grab all the tenants for this node.
    const tenants = await retrieveAllTenants(this.mongo);

    // Clear out all the items in the cache.
    this.tenantsByID.clearAll();
    this.tenantsByDomain.clearAll();
    this.tenantCountCache.clear();

    // Prime the cache with each of these tenants.
    tenants.forEach(tenant => {
      this.tenantsByID.prime(tenant.id, tenant);
      this.tenantsByDomain.prime(tenant.domain, tenant);
      this.tenantCountCache.add(tenant.id);
    });

    logger.debug({ tenants: tenants.length }, "primed all tenants");
    this.primed = true;
  }

  /**
   *  onMessage is fired every time the client gets a subscription event.
   */
  private onMessage = async (
    channel: string,
    message: string
  ): Promise<void> => {
    // Only do things when the message is for tenant.
    if (channel !== TENANT_UPDATE_CHANNEL) {
      return;
    }

    try {
      // Updated tenant come from the messages.
      const { tenant, clientApplicationID }: TenantUpdateMessage = JSON.parse(
        message
      );

      // Check to see if this was the update issued by this instance.
      if (clientApplicationID === this.clientApplicationID) {
        // It was, so just return here, we already updated/handled it.
        return;
      }

      logger.debug({ tenant_id: tenant.id }, "received updated tenant");

      // Update the tenant cache.
      this.tenantsByID.clear(tenant.id).prime(tenant.id, tenant);
      this.tenantsByDomain.clear(tenant.domain).prime(tenant.domain, tenant);
      this.tenantCountCache.add(tenant.id);

      // Publish the event for the connected listeners.
      this.emitter.emit(EMITTER_EVENT_NAME, tenant);
    } catch (err) {
      logger.error(
        { err },
        "an error occurred while trying to parse/prime the tenant/tenant cache"
      );
    }
  };

  public async retrieveByID(id: string): Promise<Readonly<Tenant> | null> {
    return this.tenantsByID.load(id);
  }

  public async retrieveByDomain(
    domain: string
  ): Promise<Readonly<Tenant> | null> {
    return this.tenantsByDomain.load(domain);
  }

  /**
   * This allows you to subscribe to new Tenant updates. This will also return
   * a function that when called, unsubscribes you from updates.
   *
   * @param callback the function to be called when there is an updated Tenant.
   */
  public subscribe(callback: SubscribeCallback) {
    this.emitter.on(EMITTER_EVENT_NAME, callback);

    // Return the unsubscribe function.
    return () => {
      this.emitter.removeListener(EMITTER_EVENT_NAME, callback);
    };
  }

  /**
   * update will update the value for Tenant in the local cache and publish
   * a change notification that will be used to keep the other nodes in sync.
   *
   * @param conn a redis connection used to publish the change notification
   * @param tenant the updated Tenant object
   */
  public async update(conn: Redis, tenant: Tenant): Promise<void> {
    // Update the tenant in the local cache.
    this.tenantsByID.clear(tenant.id).prime(tenant.id, tenant);
    this.tenantsByDomain.clear(tenant.domain).prime(tenant.domain, tenant);
    this.tenantCountCache.add(tenant.id);

    // Notify the other nodes about the tenant change.
    const message: TenantUpdateMessage = {
      tenant,
      clientApplicationID: this.clientApplicationID,
    };

    const subscribers = await conn.publish(
      TENANT_UPDATE_CHANNEL,
      JSON.stringify(message)
    );

    logger.debug({ tenant_id: tenant.id, subscribers }, "updated tenant");

    // Publish the event for the connected listeners.
    this.emitter.emit(EMITTER_EVENT_NAME, tenant);
  }
}