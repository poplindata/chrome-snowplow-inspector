import m = require("mithril");

import Registry = require("./Registry");
import { RegistrySpec } from "../types";

class DataStructuresRegistry extends Registry {
  constructor(spec: RegistrySpec) {
    super();
  }

  walk() {}
  view() {
    return m("p", "DataStructure Registry");
  }
}

export = DataStructuresRegistry;