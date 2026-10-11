#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>

@interface RuntimeModule : NSObject <RCTBridgeModule>
@end

@implementation RuntimeModule

RCT_EXPORT_MODULE(RuntimeModule)

RCT_EXPORT_METHOD(activate)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [[UIApplication sharedApplication] setIdleTimerDisabled:YES];
  });
}

RCT_EXPORT_METHOD(deactivate)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [[UIApplication sharedApplication] setIdleTimerDisabled:NO];
  });
}

RCT_EXPORT_METHOD(copyText:(NSString *)text)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIPasteboard generalPasteboard].string = text;
  });
}

// Serialize chat state through Foundation's atomic file replacement.
RCT_EXPORT_METHOD(writeState:(NSString *)content
                  path:(NSString *)path
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSError *error = nil;
  if (![content writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
    reject(@"EWRITE", error.localizedDescription, error);
    return;
  }
  resolve(nil);
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
