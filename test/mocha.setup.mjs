// Don't silently swallow unhandled rejections
process.on("unhandledRejection", (error) => {
  throw error;
});

// Enable the should interface and load Chai plugins
import * as chai from "chai";
import sinonChai from "sinon-chai";
import chaiAsPromised from "chai-as-promised";

chai.use(sinonChai);
chai.use(chaiAsPromised);
chai.should();
