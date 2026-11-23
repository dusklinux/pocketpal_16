#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <os/proc.h>
#import <mach/mach.h>
#import <sys/sysctl.h>

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

// Query real-time process headroom and Jetsam physical footprint on iOS 16+.
RCT_EXPORT_METHOD(getMemoryInfo:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    uint64_t availableBytes = (uint64_t)os_proc_available_memory();
    BOOL availableKnown = availableBytes > 0;

    task_vm_info_data_t vmInfo = {};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    kern_return_t kr = task_info(mach_task_self(),
                                 TASK_VM_INFO,
                                 (task_info_t)&vmInfo,
                                 &count);
    uint64_t footprintBytes = (kr == KERN_SUCCESS) ? (uint64_t)vmInfo.phys_footprint : 0;
    uint64_t totalBytes = (uint64_t)[[NSProcessInfo processInfo] physicalMemory];

    resolve(@{
      @"availableBytes": @(availableBytes),
      @"availableKnown": @(availableKnown),
      @"footprintBytes": @(footprintBytes),
      @"totalBytes": @(totalBytes),
    });
  } @catch (NSException *exception) {
    reject(@"EMEM", exception.reason ?: @"Could not retrieve memory info", nil);
  }
}

// Query active logical cores and performance-core topology without blocking main queue.
RCT_EXPORT_METHOD(getCpuInfo:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSUInteger activeCores = [[NSProcessInfo processInfo] activeProcessorCount];
    int32_t perfCores = 0;
    size_t size = sizeof(perfCores);
    if (sysctlbyname("hw.perflevel0.physicalcpu", &perfCores, &size, NULL, 0) != 0 || perfCores < 0) {
      perfCores = 0;
    }

    resolve(@{
      @"activeCores": @(activeCores),
      @"performanceCores": @(perfCores),
    });
  } @catch (NSException *exception) {
    reject(@"ECPU", exception.reason ?: @"Could not retrieve CPU info", nil);
  }
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
