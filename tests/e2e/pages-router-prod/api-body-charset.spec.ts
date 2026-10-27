import {
  testPagesApiBodyCharsetRejections,
  testPagesApiBodyCharsets,
} from "../pages-api-body-charset";

testPagesApiBodyCharsets("http://localhost:4175");
testPagesApiBodyCharsetRejections("http://localhost:4175");
